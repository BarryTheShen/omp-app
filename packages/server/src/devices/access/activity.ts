/**
 * What ran on each machine (#20): one line per record in `<app data>/device-access/activity/<machine id>.jsonl`
 * (owner-only), as the machine signed it, with the chat and whether it checked out. The machine's journal is the copy to
 * trust; this one feeds the app's panel and history.
 */
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { AccessActivity } from "@omp-app/contracts";

export class ActivityLog {
  readonly #folder: string;
  /** The highest verified `seq` kept per machine. */
  readonly #lastSeq = new Map<string, number>();
  /** Verified records kept started with no end yet, per machine (a link that ends may leave them to the next). */
  readonly #open = new Map<string, Set<number>>();
  #writing: Promise<void> = Promise.resolve();

  private constructor(folder: string) {
    this.#folder = folder;
  }

  static async open(folder: string, machineIds: readonly string[]): Promise<ActivityLog> {
    const log = new ActivityLog(folder);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const id of machineIds) {
      let last = 0;
      for (const activity of await log.#read(id)) {
        if (activity.verified && activity.record.seq > last) last = activity.record.seq;
        log.#track(activity);
      }
      log.#lastSeq.set(id, last);
    }
    return log;
  }

  lastSeq(machineId: string): number {
    return this.#lastSeq.get(machineId) ?? 0;
  }

  /** The machine's verified runs with no end kept yet. */
  openRuns(machineId: string): ReadonlySet<number> {
    return this.#open.get(machineId) ?? new Set();
  }

  #track(activity: AccessActivity): void {
    if (!activity.verified) return;
    const id = activity.record.machineId;
    const open = this.#open.get(id) ?? new Set<number>();
    this.#open.set(id, open);
    if (activity.record.endedAt === null) open.add(activity.record.seq);
    else open.delete(activity.record.seq);
  }

  /** Keeps a record; resolves once it is on disk, after the ones before it. */
  append(activity: AccessActivity): Promise<void> {
    const id = activity.record.machineId;
    if (activity.verified && activity.record.seq > this.lastSeq(id))
      this.#lastSeq.set(id, activity.record.seq);
    this.#track(activity);
    const write = this.#writing.then(() =>
      appendFile(this.#path(id), `${JSON.stringify(activity)}\n`, { mode: 0o600 }),
    );
    this.#writing = write.catch(() => undefined);
    return write;
  }

  /** The machine's records, newest first; `before` a `seq` pages back. */
  async history(machineId: string, before?: number, limit = 100): Promise<AccessActivity[]> {
    await this.#writing;
    const all = await this.#read(machineId);
    const picked =
      before === undefined ? all : all.filter((activity) => activity.record.seq < before);
    return picked.reverse().slice(0, limit);
  }

  /** Forgets a machine's records. */
  async remove(machineId: string): Promise<void> {
    await this.#writing;
    this.#lastSeq.delete(machineId);
    this.#open.delete(machineId);
    await rm(this.#path(machineId), { force: true });
  }

  #path(machineId: string): string {
    return join(this.#folder, `${machineId}.jsonl`);
  }

  async #read(machineId: string): Promise<AccessActivity[]> {
    const text = await readFile(this.#path(machineId), "utf8").catch(() => "");
    const out: AccessActivity[] = [];
    for (const line of text.split("\n")) {
      if (line === "") continue;
      try {
        const parsed = AccessActivity.safeParse(JSON.parse(line));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // A torn last line (the server stopped mid-write) is skipped.
      }
    }
    return out;
  }
}
