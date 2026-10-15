import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BackgroundJobStop } from "@omp-app/contracts";
import { resolveAppDataDir, writeFileAtomic } from "../fs";

/** The folder under the app's data folder that holds one file per chat. */
const DIRECTORY = "background-job-stops";

/** How many stops one chat keeps by default. A record past the limit drops the oldest. */
export const BACKGROUND_JOB_STOPS_LIMIT = 200;

export interface BackgroundJobStopStoreOptions {
  readonly appDataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly cwd?: string;
  /** How many stops a chat keeps. */
  readonly limit?: number;
  /** The time a stop is recorded (ms). The default is the server's clock. */
  readonly now?: () => number;
  /** Receives a file the store cannot read or write. The stop it was about has already happened in omp. */
  readonly onError?: (error: unknown) => void;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * The background jobs the Stop control stopped, or found finished, per chat, as omp answered, each with the time the
 * server recorded it. A stop kept here is read by every browser that opens the chat, so a reload, or another browser,
 * does not show a stopped job as running. omp numbers jobs per process, so a job id is only unique while its process
 * lives: a chat keeps the newest stop of each job id, and a card reads it only when the stop came after its launch.
 */
export class BackgroundJobStopStoreService {
  readonly appDataDir: string;
  readonly #limit: number;
  readonly #now: () => number;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #writes = new Map<string, Promise<void>>();

  constructor(options: BackgroundJobStopStoreOptions = {}) {
    const env =
      options.appDataDir === undefined
        ? options.env
        : { ...(options.env ?? {}), OMP_APP_DATA_DIR: options.appDataDir };
    this.appDataDir = resolveAppDataDir({ env, homeDir: options.homeDir, cwd: options.cwd });
    this.#limit = options.limit ?? BACKGROUND_JOB_STOPS_LIMIT;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError;
  }

  /** The stops one chat's jobs have, most recent last. A file that cannot be read counts as no stops. */
  async list(threadId: string): Promise<readonly BackgroundJobStop[]> {
    let raw: string;
    try {
      raw = await readFile(this.#fileOf(threadId), "utf8");
    } catch (error) {
      if (!isMissing(error)) this.#report(error);
      return [];
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      this.#report(error);
      return [];
    }
    const parsed = BackgroundJobStop.array().safeParse(value);
    if (!parsed.success) {
      this.#report(parsed.error);
      return [];
    }
    return parsed.data;
  }

  /**
   * Keeps a stop for one job of one chat, stamped with the time it is recorded, in place of an earlier stop for the same
   * job. Writes to one chat run in order. A write that fails is reported, not thrown: the stop has already happened in omp.
   */
  record(threadId: string, stop: Pick<BackgroundJobStop, "jobId" | "status">): Promise<void> {
    const previous = this.#writes.get(threadId) ?? Promise.resolve();
    const write = previous
      .then(() => this.#write(threadId, stop))
      .catch((error: unknown) => this.#report(error));
    this.#writes.set(threadId, write);
    return write;
  }

  async #write(threadId: string, stop: Pick<BackgroundJobStop, "jobId" | "status">): Promise<void> {
    const kept = (await this.list(threadId)).filter((entry) => entry.jobId !== stop.jobId);
    const recorded: BackgroundJobStop = { jobId: stop.jobId, status: stop.status, at: this.#now() };
    await mkdir(join(this.appDataDir, DIRECTORY), { recursive: true });
    await writeFileAtomic(
      this.#fileOf(threadId),
      JSON.stringify([...kept, recorded].slice(-this.#limit)),
    );
  }

  #fileOf(threadId: string): string {
    return join(this.appDataDir, DIRECTORY, `${encodeURIComponent(threadId)}.json`);
  }

  #report(error: unknown): void {
    this.#onError?.(error);
  }
}
