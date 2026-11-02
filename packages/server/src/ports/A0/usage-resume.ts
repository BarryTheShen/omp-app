import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThreadId } from "@omp-app/contracts";
import type { ChatEvent } from "@omp-app/contracts/chat-host";
import type { Logger } from "../../logging/logger";
import type { ProcessTimer } from "../../process/omp-process";

/**
 * How long after omp's own retry was due the app retries once itself. omp's continue goes first; the app's is the
 * backstop for the one omp drops (#2781: its wait woke on time and skipped its own continue).
 */
export const RESUME_GRACE_MS = 60_000;
/** The app's retries in a row for one chat before it leaves the chat stopped: an error that outlives every reset. */
export const RESUME_MOST_IN_ROW = 3;
/** A resume due while the server was down runs this long after the server is back, once the chats' hosts reconnected. */
export const RESUME_AFTER_START_MS = 30_000;
/**
 * A chat whose turn is running when its retry comes due (omp's own retry, or a message sent) is looked at again this
 * long after; that turn ending well drops the retry, so only a turn that fails again leaves it to run.
 */
export const RESUME_RECHECK_MS = 60_000;

/** What the app's retry found: sent, or why it sent nothing. */
export type ResumeOutcome = "sent" | "busy" | "paused" | "gone";

export interface UsageResumeDeps {
  readonly now: () => number;
  readonly timer: ProcessTimer;
  /** The kept schedule (chat → when, epoch ms); empty when there is none. */
  readonly load: () => Promise<ReadonlyMap<ThreadId, number>>;
  readonly save: (schedule: ReadonlyMap<ThreadId, number>) => Promise<void>;
  /** Runs the chat's failed turn again, as Retry does. */
  readonly resume: (threadId: ThreadId) => Promise<ResumeOutcome>;
  readonly logger?: Logger;
}

/** omp's own note of the provider's wait, at the end of a failed turn's error: `retry-after-ms=9385000`. */
const RETRY_AFTER = /\bretry-after-ms=(\d+)\b/;

/** Hears a chat's retry being set (its time, epoch ms) or dropped (`null`). */
export type UsageResumeListener = (threadId: ThreadId, continuesAt: number | null) => void;

/**
 * The app's own retry after a usage or rate limit (#2781). Each time omp waits out a limit (`auto_retry_start`), or a
 * turn ends refused with the provider's wait in its error, the app keeps "retry this chat at the end of the wait, plus
 * `RESUME_GRACE_MS`", on disk, whatever the wait: omp can skip its own continue after a short one too. A later refusal
 * moves it later, never earlier, so a short wait does not cut a long one. Only an answer drops it (an assistant message
 * that ends without an error: omp's own retry worked, or another turn did), or the reader stopping the chat or saying not
 * to continue it; a run starting is no answer, as the turn a job's result or a message starts can be refused too (#2781:
 * a job's result started a turn, the limit refused it, and nothing was left to continue the chat). When it comes due, a
 * chat with no turn running and not paused is retried once, as its Retry button does; one whose turn is running is looked
 * at again `RESUME_RECHECK_MS` later. An idle chat with a retry due is not stopped (`isWaiting`).
 */
export class UsageResume {
  readonly #deps: UsageResumeDeps;
  readonly #due = new Map<ThreadId, { readonly at: number; readonly handle: unknown }>();
  /** The app's retries since each chat's last turn that ended without an error. */
  readonly #inRow = new Map<ThreadId, number>();
  readonly #listeners = new Set<UsageResumeListener>();
  #saving: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(deps: UsageResumeDeps) {
    this.#deps = deps;
  }

  /** Takes up the schedule kept before the server started; a retry already due runs `RESUME_AFTER_START_MS` from now. */
  async restore(): Promise<void> {
    const kept = await this.#deps.load().catch((failure: unknown) => {
      this.#deps.logger?.warn("usage_resume.load_failed", { error: String(failure) });
      return new Map<ThreadId, number>();
    });
    const earliest = this.#deps.now() + RESUME_AFTER_START_MS;
    for (const [threadId, at] of kept) this.#schedule(threadId, Math.max(at, earliest), false);
  }

  /** Follows a chat's events: what omp waits for, each turn refused with the provider's wait, and each answer. */
  onEvent(threadId: ThreadId, event: ChatEvent): void {
    if (event.type === "auto_retry_start") {
      this.#later(threadId, this.#deps.now() + event.delayMs + RESUME_GRACE_MS);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      if (message.stopReason !== "error") {
        this.#inRow.delete(threadId);
        this.#drop(threadId, "answered");
        return;
      }
      const waitMs = Number(RETRY_AFTER.exec(message.errorMessage ?? "")?.[1] ?? Number.NaN);
      if (Number.isFinite(waitMs)) {
        this.#later(threadId, this.#deps.now() + waitMs + RESUME_GRACE_MS);
      }
    }
  }

  /** The reader stopped the chat, or said not to continue it: no retry of the app's either. */
  cancel(threadId: ThreadId): void {
    this.#drop(threadId, "cancelled");
  }

  /** Whether the chat has a retry due: its omp is kept up until then. */
  isWaiting(threadId: ThreadId): boolean {
    return this.#due.has(threadId);
  }

  /** Every chat with a retry due, and when (epoch ms). */
  due(): ReadonlyMap<ThreadId, number> {
    return new Map([...this.#due].map(([threadId, { at }]) => [threadId, at] as const));
  }

  /** Calls `listener` each time a chat's retry is set or dropped; the returned function stops it. */
  onChange(listener: UsageResumeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Stops every timer; the kept schedule stays for the next start. */
  close(): void {
    this.#closed = true;
    for (const { handle } of this.#due.values()) this.#deps.timer.clearTimeout(handle);
    this.#due.clear();
  }

  #schedule(threadId: ThreadId, when: number, keep: boolean): void {
    if (this.#closed) return;
    const tries = this.#inRow.get(threadId) ?? 0;
    if (tries >= RESUME_MOST_IN_ROW) {
      this.#deps.logger?.warn("usage_resume.gave_up", { threadId, tries });
      return;
    }
    const at = Math.round(when);
    const before = this.#due.get(threadId);
    if (before !== undefined) this.#deps.timer.clearTimeout(before.handle);
    const handle = this.#deps.timer.setTimeout(
      () => void this.#fire(threadId),
      Math.max(0, at - this.#deps.now()),
    );
    this.#due.set(threadId, { at, handle });
    this.#deps.logger?.info("usage_resume.scheduled", { threadId, at: new Date(at).toISOString() });
    if (keep) this.#keep();
    this.#notify(threadId, at);
  }

  /** Keeps the chat's retry at `when`, or at the time kept already when that is later. */
  #later(threadId: ThreadId, when: number): void {
    const kept = this.#due.get(threadId);
    if (kept !== undefined && kept.at >= Math.round(when)) return;
    this.#schedule(threadId, when, true);
  }

  #drop(threadId: ThreadId, reason: "answered" | "cancelled"): void {
    const due = this.#due.get(threadId);
    if (due === undefined) return;
    this.#deps.timer.clearTimeout(due.handle);
    this.#due.delete(threadId);
    this.#deps.logger?.info("usage_resume.dropped", { threadId, reason });
    this.#keep();
    this.#notify(threadId, null);
  }

  async #fire(threadId: ThreadId): Promise<void> {
    if (this.#closed || !this.#due.has(threadId)) return;
    this.#due.delete(threadId);
    this.#keep();
    this.#notify(threadId, null);
    const tries = this.#inRow.get(threadId) ?? 0;
    this.#inRow.set(threadId, tries + 1);
    const outcome = await this.#deps.resume(threadId).catch((failure: unknown) => {
      this.#deps.logger?.warn("usage_resume.failed", { threadId, error: String(failure) });
      return undefined;
    });
    if (outcome !== undefined) this.#deps.logger?.info("usage_resume.fired", { threadId, outcome });
    // Only a retry sent is a try of the three in a row.
    if (outcome !== "sent") this.#inRow.set(threadId, tries);
    // A turn runs now: look again; it ending well drops the retry (#2781, 2026-11-01 19:31: dropped as busy, lost).
    if (outcome === "busy") this.#schedule(threadId, this.#deps.now() + RESUME_RECHECK_MS, true);
  }

  #notify(threadId: ThreadId, continuesAt: number | null): void {
    for (const listener of [...this.#listeners]) listener(threadId, continuesAt);
  }

  /** Writes the schedule after the writes before it, so the file holds the last one. */
  #keep(): void {
    const schedule = this.due();
    this.#saving = this.#saving
      .then(() => this.#deps.save(schedule))
      .catch((failure: unknown) => {
        this.#deps.logger?.warn("usage_resume.save_failed", { error: String(failure) });
      });
  }
}

/** The schedule's file: `{ "version": 1, "chats": { "<thread id>": <epoch ms> } }`. */
export function usageResumeFile(path: string): Pick<UsageResumeDeps, "load" | "save"> {
  return {
    load: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return new Map();
        throw failure;
      }
      const saved = JSON.parse(text) as { readonly version?: unknown; readonly chats?: unknown };
      const chats = saved.version === 1 && typeof saved.chats === "object" ? saved.chats : null;
      const schedule = new Map<ThreadId, number>();
      for (const [threadId, at] of Object.entries(chats ?? {})) {
        if (typeof at === "number" && Number.isFinite(at)) schedule.set(threadId as ThreadId, at);
      }
      return schedule;
    },
    save: async (schedule) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, chats: Object.fromEntries(schedule) }, null, 2)}\n`,
      );
      await rename(temporary, path);
    },
  };
}
