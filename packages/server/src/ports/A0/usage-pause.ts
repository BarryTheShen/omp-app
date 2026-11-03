import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThreadId, UsageLimitsResult, UsagePauseHold } from "@omp-app/contracts";
import type { Logger } from "../../logging/logger";
import type { ProcessTimer } from "../../process/omp-process";

/** The window the usage pause watches: each provider's 5-hour window (#2781). */
export const USAGE_PAUSE_WINDOW_MS = 5 * 3_600_000;
/** A held chat resumes this long after its window's reset, once the provider counts the new window. */
export const USAGE_PAUSE_RESUME_GRACE_MS = 60_000;
/** A resume due while the server was down runs this long after the server is back, once the chats' hosts reconnected. */
export const USAGE_PAUSE_AFTER_START_MS = 30_000;

/** A chat's mark: pause at `percent` of its provider's 5-hour window; `folder` lists it with the folder's chats. */
export interface UsagePauseMark {
  readonly percent: number;
  readonly folder: string;
}

/** What is kept on disk: the marks, and the holds the rule has not ended yet. */
export interface UsagePauseKept {
  readonly marks: ReadonlyMap<ThreadId, UsagePauseMark>;
  readonly holds: ReadonlyMap<ThreadId, UsagePauseHold>;
}

export interface UsagePauseDeps {
  readonly now: () => number;
  readonly timer: ProcessTimer;
  readonly load: () => Promise<UsagePauseKept>;
  readonly save: (kept: UsagePauseKept) => Promise<void>;
  /** The provider of the model the chat runs now; null when its omp is not running. */
  readonly providerOf: (threadId: ThreadId) => Promise<string | null>;
  /** Holds the chat's agents at their next step, as omp's `/pause`; false when its omp is not running. */
  readonly pause: (threadId: ThreadId) => Promise<boolean>;
  readonly resume: (threadId: ThreadId) => Promise<boolean>;
  /** Whether the chat is paused now, whoever paused it (the pause the chat's host reports). */
  readonly isPaused: (threadId: ThreadId) => boolean;
  readonly logger?: Logger;
}

/** Hears a chat's mark or hold change: `percent` null when it is no longer marked, `hold` null while it is not held. */
export type UsagePauseListener = (
  threadId: ThreadId,
  folder: string,
  percent: number | null,
  hold: UsagePauseHold | null,
) => void;

const EMPTY: UsagePauseKept = { marks: new Map(), holds: new Map() };

/** The provider's 5-hour window in a usage read, by its length: providers label it differently. */
function fiveHourWindow(
  result: UsageLimitsResult,
  providerId: string,
): { readonly usedPercent: number; readonly resetsAt: string | null } | undefined {
  if (result.state !== "ready") return undefined;
  return result.providers
    .find((provider) => provider.providerId === providerId)
    ?.windows.find((window) => window.durationMs === USAGE_PAUSE_WINDOW_MS);
}

/** The fullest 5-hour window of any provider in the read: below every mark, no chat needs its provider asked. */
function fullestFiveHour(result: UsageLimitsResult): number {
  if (result.state !== "ready") return 0;
  let fullest = 0;
  for (const provider of result.providers) {
    for (const window of provider.windows) {
      if (window.durationMs === USAGE_PAUSE_WINDOW_MS)
        fullest = Math.max(fullest, window.usedPercent);
    }
  }
  return fullest;
}

/**
 * The usage pause (#2781 part 3). Only the chats marked for it pause, each at its own share of its provider's 5-hour
 * window (95% unless set otherwise): on each usage read, a marked chat that runs and is not paused already is paused
 * (omp's `/pause`: its agents hold at their next step) once the window of the provider its model runs on is at or past
 * its limit, and the rule keeps a hold on it. A hold ends at the window's reset plus `USAGE_PAUSE_RESUME_GRACE_MS`, or
 * at the first read below the chat's limit again (a reset omp gave no time for, or a limit raised), and the chat
 * resumes. A chat that was paused already is left alone, and one resumed by anyone else meanwhile ends its hold, so a
 * pause or resume of the reader's own is never undone. Unmarking a held chat resumes it. Marks and holds are kept on
 * disk; a resume that fell due while the server was down runs `USAGE_PAUSE_AFTER_START_MS` after it is back.
 */
export class UsagePause {
  readonly #deps: UsagePauseDeps;
  readonly #marks = new Map<ThreadId, UsagePauseMark>();
  readonly #holds = new Map<ThreadId, UsagePauseHold>();
  readonly #timers = new Map<ThreadId, unknown>();
  readonly #listeners = new Set<UsagePauseListener>();
  /** The last usage read, so a mark set or changed is judged at once. */
  #usage: UsageLimitsResult | null = null;
  /** Judgments run one after another: each asks chats for their provider and pauses or resumes them. */
  #judging: Promise<void> = Promise.resolve();
  #saving: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(deps: UsagePauseDeps) {
    this.#deps = deps;
  }

  /** Takes up the marks and holds kept before the server started. */
  async restore(): Promise<void> {
    const kept = await this.#deps.load().catch((failure: unknown) => {
      this.#deps.logger?.warn("usage_pause.load_failed", { error: String(failure) });
      return EMPTY;
    });
    for (const [threadId, mark] of kept.marks) this.#marks.set(threadId, mark);
    const earliest = this.#deps.now() + USAGE_PAUSE_AFTER_START_MS;
    for (const [threadId, hold] of kept.holds) {
      if (!this.#marks.has(threadId)) continue;
      this.#holds.set(threadId, hold);
      if (hold.until !== null) this.#schedule(threadId, Math.max(hold.until, earliest));
    }
  }

  /** The chats of a folder that are marked, with their limits and holds. */
  marksIn(folder: string): readonly {
    readonly id: ThreadId;
    readonly percent: number;
    readonly hold: UsagePauseHold | null;
  }[] {
    return [...this.#marks]
      .filter(([, mark]) => mark.folder === folder)
      .map(([id, mark]) => ({ id, percent: mark.percent, hold: this.#holds.get(id) ?? null }));
  }

  /**
   * Marks the chat to pause at `percent` of its provider's 5-hour window, or unmarks it (`null`). The new limit is
   * judged against the last read at once: a lower one can pause the chat now, a higher one can end its hold.
   */
  setMark(threadId: ThreadId, folder: string, percent: number | null): Promise<void> {
    return this.#queue(async () => {
      if (percent === null) {
        const mark = this.#marks.get(threadId);
        if (mark === undefined) return;
        this.#marks.delete(threadId);
        this.#deps.logger?.info("usage_pause.unmarked", { threadId });
        await this.#release(threadId, "unmarked", mark.folder);
        this.#keep();
        this.#notify(threadId, mark.folder);
        return;
      }
      this.#marks.set(threadId, { percent, folder });
      this.#deps.logger?.info("usage_pause.marked", { threadId, percent });
      this.#keep();
      this.#notify(threadId, folder);
      if (this.#usage !== null) await this.#judge(this.#usage, [threadId]);
    });
  }

  /** A fresh usage read: marked chats at or past their limit pause, held ones under it again resume. */
  onUsage(result: UsageLimitsResult): Promise<void> {
    if (result.state !== "ready") return Promise.resolve();
    this.#usage = result;
    return this.#queue(() => this.#judge(result, [...this.#marks.keys()]));
  }

  /** The chat's pause changed: a held chat running again was resumed by someone else, so the rule lets it be. */
  onPauseChanged(threadId: ThreadId, pausedAt: number | null): void {
    if (pausedAt !== null || !this.#holds.has(threadId)) return;
    this.#endHold(threadId, "resumed_elsewhere");
  }

  /** The chat moved to omp's new id for it: its mark and hold go with it. */
  move(from: ThreadId, to: ThreadId): void {
    const mark = this.#marks.get(from);
    if (mark === undefined) return;
    this.#marks.delete(from);
    this.#marks.set(to, mark);
    const hold = this.#holds.get(from);
    if (hold !== undefined) {
      this.#holds.delete(from);
      this.#holds.set(to, hold);
      this.#clearTimer(from);
      if (hold.until !== null) this.#schedule(to, hold.until);
    }
    this.#keep();
    this.#notify(from, mark.folder, null, null);
    this.#notify(to, mark.folder);
  }

  /** Calls `listener` each time a chat's mark or hold changes; the returned function stops it. */
  onChange(listener: UsagePauseListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Stops every timer; the marks and holds stay on disk for the next start. */
  close(): void {
    this.#closed = true;
    for (const handle of this.#timers.values()) this.#deps.timer.clearTimeout(handle);
    this.#timers.clear();
  }

  async #judge(result: UsageLimitsResult, threadIds: readonly ThreadId[]): Promise<void> {
    const fullest = fullestFiveHour(result);
    for (const threadId of threadIds) {
      if (this.#closed) return;
      const mark = this.#marks.get(threadId);
      if (mark === undefined) continue;
      const hold = this.#holds.get(threadId);
      if (hold !== undefined) {
        const window = fiveHourWindow(result, hold.providerId);
        // Under the chat's limit again: the window was reset, or the limit raised.
        if (window !== undefined && window.usedPercent < mark.percent) {
          await this.#release(threadId, "under_limit", mark.folder);
        }
        continue;
      }
      if (fullest < mark.percent || this.#deps.isPaused(threadId)) continue;
      const providerId = await this.#deps.providerOf(threadId).catch(() => null);
      if (providerId === null) continue;
      const window = fiveHourWindow(result, providerId);
      if (window === undefined || window.usedPercent < mark.percent) continue;
      const paused = await this.#deps.pause(threadId).catch((failure: unknown) => {
        this.#deps.logger?.warn("usage_pause.pause_failed", { threadId, error: String(failure) });
        return false;
      });
      if (!paused || !this.#marks.has(threadId)) continue;
      const reset = window.resetsAt === null ? Number.NaN : Date.parse(window.resetsAt);
      const until = Number.isFinite(reset) ? reset + USAGE_PAUSE_RESUME_GRACE_MS : null;
      this.#holds.set(threadId, { providerId, until });
      if (until !== null) this.#schedule(threadId, until);
      this.#deps.logger?.info("usage_pause.held", {
        threadId,
        providerId,
        usedPercent: window.usedPercent,
        percent: mark.percent,
        until: until === null ? null : new Date(until).toISOString(),
      });
      this.#keep();
      this.#notify(threadId, mark.folder);
    }
  }

  /** Ends the chat's hold and resumes it, if the rule holds it and it is still paused. */
  async #release(threadId: ThreadId, reason: string, folder: string): Promise<void> {
    if (!this.#holds.has(threadId)) return;
    this.#endHold(threadId, reason, folder);
    if (!this.#deps.isPaused(threadId)) return;
    const resumed = await this.#deps.resume(threadId).catch((failure: unknown) => {
      this.#deps.logger?.warn("usage_pause.resume_failed", { threadId, error: String(failure) });
      return false;
    });
    this.#deps.logger?.info("usage_pause.resumed", { threadId, reason, resumed });
  }

  #endHold(threadId: ThreadId, reason: string, folder?: string): void {
    if (!this.#holds.delete(threadId)) return;
    this.#clearTimer(threadId);
    this.#deps.logger?.info("usage_pause.hold_ended", { threadId, reason });
    this.#keep();
    const at = folder ?? this.#marks.get(threadId)?.folder;
    if (at !== undefined) this.#notify(threadId, at);
  }

  #schedule(threadId: ThreadId, at: number): void {
    if (this.#closed) return;
    this.#clearTimer(threadId);
    const handle = this.#deps.timer.setTimeout(
      () => {
        this.#timers.delete(threadId);
        void this.#queue(async () => {
          const folder = this.#marks.get(threadId)?.folder;
          if (folder !== undefined) await this.#release(threadId, "reset", folder);
        });
      },
      Math.max(0, at - this.#deps.now()),
    );
    this.#timers.set(threadId, handle);
  }

  #clearTimer(threadId: ThreadId): void {
    const handle = this.#timers.get(threadId);
    if (handle === undefined) return;
    this.#deps.timer.clearTimeout(handle);
    this.#timers.delete(threadId);
  }

  #queue(work: () => Promise<void>): Promise<void> {
    const next = this.#judging.then(work).catch((failure: unknown) => {
      this.#deps.logger?.warn("usage_pause.failed", { error: String(failure) });
    });
    this.#judging = next;
    return next;
  }

  #notify(
    threadId: ThreadId,
    folder: string,
    percent: number | null = this.#marks.get(threadId)?.percent ?? null,
    hold: UsagePauseHold | null = this.#holds.get(threadId) ?? null,
  ): void {
    for (const listener of [...this.#listeners]) listener(threadId, folder, percent, hold);
  }

  /** Writes the marks and holds after the writes before it, so the file holds the last ones. */
  #keep(): void {
    const kept: UsagePauseKept = { marks: new Map(this.#marks), holds: new Map(this.#holds) };
    this.#saving = this.#saving
      .then(() => this.#deps.save(kept))
      .catch((failure: unknown) => {
        this.#deps.logger?.warn("usage_pause.save_failed", { error: String(failure) });
      });
  }
}

/**
 * The usage pause's file: `{ "version": 1, "marks": { "<thread id>": { "percent": 95, "folder": "…" } }, "holds":
 * { "<thread id>": { "providerId": "anthropic", "until": <epoch ms or null> } } }`.
 */
export function usagePauseFile(path: string): Pick<UsagePauseDeps, "load" | "save"> {
  return {
    load: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
        throw failure;
      }
      const saved = JSON.parse(text) as {
        readonly version?: unknown;
        readonly marks?: Record<string, { readonly percent?: unknown; readonly folder?: unknown }>;
        readonly holds?: Record<
          string,
          { readonly providerId?: unknown; readonly until?: unknown }
        >;
      };
      if (saved.version !== 1) return EMPTY;
      const marks = new Map<ThreadId, UsagePauseMark>();
      for (const [threadId, mark] of Object.entries(saved.marks ?? {})) {
        const { percent, folder } = mark;
        if (
          typeof percent !== "number" ||
          !Number.isInteger(percent) ||
          percent < 1 ||
          percent > 100
        )
          continue;
        if (typeof folder !== "string" || folder.length === 0) continue;
        marks.set(threadId as ThreadId, { percent, folder });
      }
      const holds = new Map<ThreadId, UsagePauseHold>();
      for (const [threadId, hold] of Object.entries(saved.holds ?? {})) {
        const { providerId, until } = hold;
        if (typeof providerId !== "string" || providerId.length === 0) continue;
        if (until !== null && (typeof until !== "number" || !Number.isFinite(until))) continue;
        holds.set(threadId as ThreadId, {
          providerId,
          until: until === null ? null : Math.round(until),
        });
      }
      return { marks, holds };
    },
    save: async (kept) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      const file = {
        version: 1,
        marks: Object.fromEntries(kept.marks),
        holds: Object.fromEntries(kept.holds),
      };
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`);
      await rename(temporary, path);
    },
  };
}
