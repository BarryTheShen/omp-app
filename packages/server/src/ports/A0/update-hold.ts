import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { UPDATE_HOLD_MOST_MINUTES, type UpdateHoldState } from "@omp-app/contracts";
import type { Logger } from "../../logging/logger";
import type { ProcessTimer } from "../../process/omp-process";

/** A hold as it is kept: why, since when and until when (epoch ms). */
export interface KeptUpdateHold {
  readonly reason: string;
  readonly since: number;
  readonly until: number;
}

export interface UpdateHoldDeps {
  readonly now: () => number;
  readonly timer: ProcessTimer;
  /** The kept hold; null when there is none. */
  readonly load: () => Promise<KeptUpdateHold | null>;
  readonly save: (hold: KeptUpdateHold | null) => Promise<void>;
  readonly logger?: Logger;
}

const NO_HOLD: UpdateHoldState = { held: false, reason: null, since: null, until: null };

/**
 * The hold an omp update puts on the app's own work while it moves the chats to the new omp (`UpdateHoldState`): while
 * it lasts, queued tasks and the app's continues after a usage limit wait. It is kept on disk, so it holds through the
 * install's restart of the server, and it ends by itself at `until`, so an update that stops part-way cannot leave the
 * chats held; the update renews it at each step. A hold set again keeps when it began and never ends sooner than it
 * would have; only `release` ends it early.
 */
export class UpdateHold {
  readonly #deps: UpdateHoldDeps;
  #hold: KeptUpdateHold | null = null;
  #handle: unknown = null;
  #saving: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(deps: UpdateHoldDeps) {
    this.#deps = deps;
  }

  /**
   * Takes up the hold kept before the server started. One that ended meanwhile is dropped; one that ends further off than
   * a hold can be set for (a clock set back, an edited file) is brought in to `UPDATE_HOLD_MOST_MINUTES` from now.
   */
  async restore(): Promise<void> {
    const kept = await this.#deps.load().catch((failure: unknown) => {
      this.#deps.logger?.warn("update_hold.load_failed", { error: String(failure) });
      return null;
    });
    if (this.#closed || this.#hold !== null) return;
    if (kept === null) return;
    const now = this.#deps.now();
    if (kept.until <= now) {
      this.#deps.logger?.info("update_hold.ended", { reason: "expired_while_down" });
      void this.#keep();
      return;
    }
    const until = Math.min(kept.until, now + UPDATE_HOLD_MOST_MINUTES * 60_000);
    this.#set({ ...kept, until });
    if (until !== kept.until) void this.#keep();
    this.#deps.logger?.info("update_hold.restored", {
      reason: kept.reason,
      until: new Date(until).toISOString(),
    });
  }

  /** Whether the hold lasts now. */
  held(): boolean {
    return this.#hold !== null && this.#hold.until > this.#deps.now();
  }

  state(): UpdateHoldState {
    const hold = this.#hold;
    if (hold === null || !this.held()) return NO_HOLD;
    return { held: true, reason: hold.reason, since: hold.since, until: hold.until };
  }

  /**
   * Holds for `minutes` from now; a hold already on keeps when it began and its end, when that is later. Resolves once
   * the hold is on disk, and fails when it could not be written, leaving the hold as it was: an update must not go on
   * with a hold the install's restart would lose.
   */
  async hold(reason: string, minutes: number): Promise<UpdateHoldState> {
    const now = this.#deps.now();
    const before = this.held() ? this.#hold : null;
    const until = Math.max(before?.until ?? 0, now + minutes * 60_000);
    const mine: KeptUpdateHold = { reason, since: before?.since ?? now, until };
    this.#set(mine);
    try {
      await this.#keep();
    } catch (failure) {
      // Rolled back only while nothing came after it: a later hold or a release stands.
      if (this.#hold === mine) {
        if (before === null) this.#clear();
        else this.#set(before);
      }
      throw failure;
    }
    this.#deps.logger?.info("update_hold.held", { reason, until: new Date(until).toISOString() });
    return this.state();
  }

  /** Ends the hold; resolves once its file is gone. The file is removed again even when no hold is known here. */
  async release(): Promise<UpdateHoldState> {
    const had = this.#hold !== null;
    await this.#end();
    if (had) this.#deps.logger?.info("update_hold.ended", { reason: "released" });
    return NO_HOLD;
  }

  /** Stops the timer; the kept hold stays for the next start. */
  close(): void {
    this.#closed = true;
    if (this.#handle !== null) this.#deps.timer.clearTimeout(this.#handle);
    this.#handle = null;
  }

  /** The kept file is written after the writes before it, so it holds the last one. */
  saved(): Promise<void> {
    return this.#saving;
  }

  #set(hold: KeptUpdateHold): void {
    if (this.#closed) return;
    this.#hold = hold;
    if (this.#handle !== null) this.#deps.timer.clearTimeout(this.#handle);
    this.#handle = this.#deps.timer.setTimeout(
      () => {
        this.#handle = null;
        if (this.#hold !== hold) return;
        // A timer that fires before the end (an early wake) waits again for the rest.
        if (hold.until > this.#deps.now()) {
          this.#set(hold);
          return;
        }
        void this.#end();
        this.#deps.logger?.info("update_hold.ended", { reason: "expired" });
      },
      Math.max(0, hold.until - this.#deps.now()),
    );
  }

  /** No hold in memory; the file is left as it is. */
  #clear(): void {
    this.#hold = null;
    if (this.#handle !== null) this.#deps.timer.clearTimeout(this.#handle);
    this.#handle = null;
  }

  #end(): Promise<void> {
    this.#clear();
    return this.#keep();
  }

  /** Writes the hold after the writes before it; the returned write fails when this one did, the chain goes on. */
  #keep(): Promise<void> {
    const hold = this.#hold;
    const write = this.#saving.then(() => this.#deps.save(hold));
    this.#saving = write.catch((failure: unknown) => {
      this.#deps.logger?.warn("update_hold.save_failed", { error: String(failure) });
    });
    return write;
  }
}

/** The hold's file: `{ "version": 1, "reason": ..., "since": <epoch ms>, "until": <epoch ms> }`; none when it is missing. */
export function updateHoldFile(path: string): Pick<UpdateHoldDeps, "load" | "save"> {
  return {
    load: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw failure;
      }
      const saved = JSON.parse(text) as Record<string, unknown>;
      const { version, reason, since, until } = saved;
      if (
        version !== 1 ||
        typeof reason !== "string" ||
        typeof since !== "number" ||
        typeof until !== "number" ||
        !Number.isFinite(since) ||
        !Number.isFinite(until)
      ) {
        return null;
      }
      return { reason, since, until };
    },
    save: async (hold) => {
      if (hold === null) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, ...hold }, null, 2)}\n`);
      await rename(temporary, path);
    },
  };
}
