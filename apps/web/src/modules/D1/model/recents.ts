import type { AppClient } from "@omp-app/client";
import { AppFailure, ConfigStore, type Revision } from "@omp-app/contracts";
import { z } from "zod";
import type { ModelRef } from "../contract";
import { modelKey } from "./catalog";

/**
 * The app's own list of models it has used, most recent first. omp keeps its list in its agent database,
 * which RPC does not expose, so the app keeps this one in its data folder (the ConfigStore's app layer,
 * `appDataDir/config.yml`).
 */
export const RECENT_MODELS_KEY = "app.recentModels";

/** How many models the list keeps; the dialog shows them all in its Recent group. */
export const RECENT_MODELS_LIMIT = 15;

export interface RecentModelsRead {
  readonly keys: readonly string[];
  readonly revision: Revision;
}

/** Reads and writes the list. A write is a compare-and-swap on the revision it was read at. */
export interface RecentModelsPort {
  readonly read: () => Promise<RecentModelsRead>;
  readonly write: (keys: readonly string[], expectedRevision: Revision) => Promise<Revision>;
}

const StoredKeys = z.array(z.string().min(1));

/** The ConfigStore-backed port: the app layer, so the list never goes into omp's files. */
export function createConfigRecentModelsPort(client: AppClient): RecentModelsPort {
  const config = client.port(ConfigStore);
  return {
    read: async () => {
      const listed = await config.list({ prefix: RECENT_MODELS_KEY, folder: null });
      const entry = listed.entries.find((candidate) => candidate.key === RECENT_MODELS_KEY);
      if (!entry || entry.secret) return { keys: [], revision: listed.revision };
      const parsed = StoredKeys.safeParse(entry.value);
      if (!parsed.success) {
        throw new AppFailure({
          code: "invalid_args",
          message: "The saved list of recent models is not in the expected form.",
          retryable: false,
        });
      }
      return { keys: parsed.data, revision: listed.revision };
    },
    write: async (keys, expectedRevision) => {
      const result = await config.write({
        key: RECENT_MODELS_KEY,
        layer: "app",
        folder: null,
        value: { secret: false, value: [...keys] },
        expectedRevision,
      });
      return result.revision;
    },
  };
}

export interface RecentModelsSnapshot {
  /** `provider/id` keys, most recent first, at most RECENT_MODELS_LIMIT. */
  readonly keys: readonly string[];
  /** Why the list could not be read or saved, in words for the person; null when it is in step. */
  readonly error: string | null;
}

function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof AppFailure) return error.appError.message;
  return error instanceof Error ? error.message : fallback;
}

/**
 * The recent-models list in the browser. A choice shows at once; the save follows, one at a time, and
 * a save that finds the file changed elsewhere takes that list and saves the choice again.
 */
export class RecentModels {
  private readonly port: RecentModelsPort;
  private readonly listeners = new Set<(snapshot: RecentModelsSnapshot) => void>();
  private revision: Revision | null = null;
  private queue: Promise<void> = Promise.resolve();
  private snapshot: RecentModelsSnapshot = Object.freeze({ keys: [], error: null });

  public constructor(port: RecentModelsPort) {
    this.port = port;
  }

  public getSnapshot(): RecentModelsSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: (snapshot: RecentModelsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Loads the saved list. A failed read leaves the list empty and says why. */
  public async read(): Promise<void> {
    try {
      const next = await this.port.read();
      this.revision = next.revision;
      this.commit({ keys: next.keys.slice(0, RECENT_MODELS_LIMIT), error: null });
    } catch (error) {
      this.commit({ error: failureMessage(error, "The recent models could not be read.") });
    }
  }

  /** Puts the model first. Resolves once the save has been tried; a failed save is in the snapshot. */
  public record(model: ModelRef): Promise<void> {
    const key = modelKey(model);
    const keys = [key, ...this.snapshot.keys.filter((item) => item !== key)];
    this.commit({ keys: keys.slice(0, RECENT_MODELS_LIMIT), error: null });
    this.queue = this.queue.then(() => this.save());
    return this.queue;
  }

  public dispose(): void {
    this.listeners.clear();
  }

  private async save(): Promise<void> {
    try {
      if (this.revision === null) await this.refreshRevision();
      this.revision = await this.port.write(this.snapshot.keys, this.revision as Revision);
      this.commit({ error: null });
    } catch (error) {
      if (!(error instanceof AppFailure && error.appError.code === "conflict")) {
        this.commit({ error: failureMessage(error, "The recent models could not be saved.") });
        return;
      }
      await this.saveAfterConflict();
    }
  }

  /** The file changed elsewhere: keep the saved list, put the newest choice first, and save again. */
  private async saveAfterConflict(): Promise<void> {
    try {
      const head = this.snapshot.keys[0];
      const fresh = await this.port.read();
      const keys = head ? [head, ...fresh.keys.filter((item) => item !== head)] : [...fresh.keys];
      const limited = keys.slice(0, RECENT_MODELS_LIMIT);
      this.revision = await this.port.write(limited, fresh.revision);
      this.commit({ keys: limited, error: null });
    } catch (error) {
      this.commit({ error: failureMessage(error, "The recent models could not be saved.") });
    }
  }

  private async refreshRevision(): Promise<void> {
    const next = await this.port.read();
    this.revision = next.revision;
  }

  private commit(patch: Partial<RecentModelsSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
