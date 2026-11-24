import { join } from "node:path";
import { AppFailure, type AppLook, type AppLookSetArgs, AppLookValues } from "@omp-app/contracts";
import { z } from "zod";
import { compareAndSwapFile, hashContent, readFileSnapshot, resolveAppDataDir } from "../fs";

const FILE_NAME = "app-look.json";

const Saved = z.object({ version: z.literal(1), look: AppLookValues });

export interface AppLookStoreOptions {
  /** App-owned data root; defaults to OMP_APP_DATA_DIR or ~/.omp/app. */
  readonly appDataDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly homeDir?: string;
  readonly cwd?: string;
}

export type AppLookListener = (look: AppLook) => void;

/** The file's revision; a file not written yet has one too, so the first change is checked like any other. */
function revisionOf(hash: string | null): string {
  return hashContent(JSON.stringify({ hash }));
}

/**
 * The app's look for every device (`<app data>/app-look.json`, V258): what devices set to Every device show. Only this
 * server writes the file, so every change reaches the open pages as a `changed` event. A change states the revision it
 * was made on, and one made on an older revision (another device's change came first) is a retryable conflict.
 */
export class AppLookStoreService {
  readonly filePath: string;
  readonly #listeners = new Set<AppLookListener>();

  constructor(options: AppLookStoreOptions = {}) {
    this.filePath = join(options.appDataDir ?? resolveAppDataDir(options), FILE_NAME);
  }

  async read(): Promise<AppLook> {
    const { look, hash } = await this.#load();
    return { look, revision: revisionOf(hash) };
  }

  async set(args: AppLookSetArgs): Promise<AppLook> {
    const { look, hash } = await this.#load();
    if (args.expectedRevision !== revisionOf(hash)) {
      throw new AppFailure({
        code: "conflict",
        message: "The look changed on another device. Try again.",
        retryable: true,
      });
    }
    if (JSON.stringify(look) === JSON.stringify(args.look))
      return { look, revision: revisionOf(hash) };
    const written = await compareAndSwapFile(
      this.filePath,
      `${JSON.stringify({ version: 1, look: args.look }, null, 2)}\n`,
      hash,
    );
    const saved = { look: args.look, revision: revisionOf(written.hash) };
    for (const listener of this.#listeners) {
      try {
        listener(saved);
      } catch {
        // A listener that throws must not undo a change that is already saved.
      }
    }
    return saved;
  }

  /** Hears every saved change; the returned function stops it. */
  subscribe(listener: AppLookListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #load(): Promise<{ readonly look: AppLook["look"]; readonly hash: string | null }> {
    const snapshot = await readFileSnapshot(this.filePath);
    if (!snapshot.exists) return { look: {}, hash: null };
    let raw: unknown;
    try {
      raw = JSON.parse(snapshot.content ?? "");
    } catch {
      raw = undefined;
    }
    const parsed = Saved.safeParse(raw);
    // A file this app cannot read is left as it is: a change built on an empty reading would drop what it holds.
    if (!parsed.success) {
      throw new AppFailure({
        code: "invalid_args",
        message: `The app's look for every device could not be read (${this.filePath}).`,
        retryable: false,
      });
    }
    return { look: parsed.data.look, hash: snapshot.hash };
  }
}
