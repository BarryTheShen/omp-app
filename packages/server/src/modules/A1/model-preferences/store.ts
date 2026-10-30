import { join } from "node:path";
import {
  AppFailure,
  applyModelPreferenceChange,
  ModelKey,
  type ModelPreferenceSetArgs,
  type ModelPreferences,
} from "@omp-app/contracts";
import { z } from "zod";
import { compareAndSwapFile, hashContent, readFileSnapshot, resolveAppDataDir } from "../fs";

const FILE_NAME = "model-preferences.json";

const Saved = z.object({
  version: z.literal(1),
  favorites: z.array(ModelKey),
  hidden: z.array(ModelKey),
});

export interface ModelPreferenceStoreOptions {
  /** App-owned data root; defaults to OMP_APP_DATA_DIR or ~/.omp/app. */
  readonly appDataDir?: string;
  /** Environment used when resolving the default app data root. */
  readonly env?: Record<string, string | undefined>;
  /** Home directory used when resolving the default app data root. */
  readonly homeDir?: string;
  /** Base directory for a relative OMP_APP_DATA_DIR value. */
  readonly cwd?: string;
}

export type ModelPreferenceListener = (preferences: ModelPreferences) => void;

/** The file's revision; a file not written yet has one too, so the first change is checked like any other. */
function revisionOf(hash: string | null): string {
  return hashContent(JSON.stringify({ hash }));
}

const unique = (keys: readonly string[]): string[] => [...new Set(keys)];

/**
 * The model menu's stars and hidden models (`<app data>/model-preferences.json`), the app's own: omp has neither. Only
 * this server writes the file, so every change reaches the devices that have the app open as a `changed` event. A
 * change states the revision it was made on, and one made on an older revision (another device's change came first)
 * is refused as a retryable conflict, so no device overwrites another's.
 */
export class ModelPreferenceStoreService {
  readonly filePath: string;
  readonly #listeners = new Set<ModelPreferenceListener>();

  constructor(options: ModelPreferenceStoreOptions = {}) {
    this.filePath = join(options.appDataDir ?? resolveAppDataDir(options), FILE_NAME);
  }

  async read(): Promise<ModelPreferences> {
    const { saved, hash } = await this.#load();
    return { ...saved, revision: revisionOf(hash) };
  }

  async set(args: ModelPreferenceSetArgs): Promise<ModelPreferences> {
    if (args.favorite === true && args.hidden === true) {
      throw new AppFailure({
        code: "invalid_args",
        message: "A model cannot be starred and hidden at once.",
        retryable: false,
      });
    }
    const { saved, hash } = await this.#load();
    if (args.expectedRevision !== revisionOf(hash)) {
      throw new AppFailure({
        code: "conflict",
        message: "The model menu changed on another device. Try again.",
        retryable: true,
      });
    }
    const next = applyModelPreferenceChange(saved, args.model, args);
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((key, index) => key === b[index]);
    if (same(next.favorites, saved.favorites) && same(next.hidden, saved.hidden)) {
      return { ...saved, revision: revisionOf(hash) };
    }
    const written = await compareAndSwapFile(
      this.filePath,
      `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`,
      hash,
    );
    const preferences = { ...next, revision: revisionOf(written.hash) };
    for (const listener of this.#listeners) {
      try {
        listener(preferences);
      } catch {
        // A listener that throws must not undo a change that is already saved.
      }
    }
    return preferences;
  }

  /** Hears every saved change; the returned function stops it. */
  subscribe(listener: ModelPreferenceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #load(): Promise<{
    readonly saved: { favorites: string[]; hidden: string[] };
    readonly hash: string | null;
  }> {
    const snapshot = await readFileSnapshot(this.filePath);
    if (!snapshot.exists) return { saved: { favorites: [], hidden: [] }, hash: null };
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
        message: `The model menu's saved stars and hidden models could not be read (${this.filePath}).`,
        retryable: false,
      });
    }
    return {
      saved: { favorites: unique(parsed.data.favorites), hidden: unique(parsed.data.hidden) },
      hash: snapshot.hash,
    };
  }
}
