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

const configRecentModelsPorts = new WeakMap<AppClient, RecentModelsPort>();

/** The ConfigStore-backed port: the app layer, so the list never goes into omp's files. */
export function createConfigRecentModelsPort(client: AppClient): RecentModelsPort {
  const existing = configRecentModelsPorts.get(client);
  if (existing) return existing;

  const config = client.port(ConfigStore);
  const port: RecentModelsPort = {
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
  configRecentModelsPorts.set(client, port);
  return port;
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

type RecentModelsState = {
  revision: Revision | null;
  queue: Promise<void>;
  snapshot: RecentModelsSnapshot;
  pendingKeys: string[];
  retainedKeys: string[];
  saveError: string | null;
  instances: Set<RecentModels>;
};

const recentModelsStates = new WeakMap<RecentModelsPort, RecentModelsState>();

function recentModelsState(port: RecentModelsPort): RecentModelsState {
  const existing = recentModelsStates.get(port);
  if (existing) return existing;
  const state: RecentModelsState = {
    revision: null,
    queue: Promise.resolve(),
    snapshot: Object.freeze({ keys: [], error: null }),
    pendingKeys: [],
    retainedKeys: [],
    saveError: null,
    instances: new Set(),
  };
  recentModelsStates.set(port, state);
  return state;
}

function orderedKeys(keys: readonly string[]): string[] {
  return [...new Set(keys)].slice(0, RECENT_MODELS_LIMIT);
}

/**
 * The recent-models list in the browser. Dialog instances using the same ConfigStore port share their optimistic
 * picks and serialized writes, so a read from a newly opened dialog cannot replace a pick that is still saving.
 */
export class RecentModels {
  private readonly port: RecentModelsPort;
  private readonly state: RecentModelsState;
  private readonly listeners = new Set<(snapshot: RecentModelsSnapshot) => void>();

  public constructor(port: RecentModelsPort) {
    this.port = port;
    this.state = recentModelsState(port);
    this.state.instances.add(this);
  }

  public getSnapshot(): RecentModelsSnapshot {
    return this.state.snapshot;
  }

  public subscribe(listener: (snapshot: RecentModelsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Loads saved models without dropping picks whose writes are still in flight or have failed. */
  public async read(): Promise<void> {
    try {
      const next = await this.port.read();
      this.state.revision = next.revision;
      this.commit({
        keys: orderedKeys([...this.state.pendingKeys, ...this.state.retainedKeys, ...next.keys]),
        error: this.state.saveError,
      });
    } catch (error) {
      this.commit({
        error:
          this.state.saveError ?? failureMessage(error, "The recent models could not be read."),
      });
    }
  }

  /** Puts the model first. Resolves once the save has been tried; a failed save is in the snapshot. */
  public record(model: ModelRef): Promise<void> {
    const key = modelKey(model);
    this.state.pendingKeys = orderedKeys([
      key,
      ...this.state.pendingKeys.filter((item) => item !== key),
    ]);
    this.state.saveError = null;
    this.commit({
      keys: orderedKeys([key, ...this.state.snapshot.keys.filter((item) => item !== key)]),
      error: null,
    });
    this.state.queue = this.state.queue.then(() => this.save());
    return this.state.queue;
  }

  public dispose(): void {
    this.state.instances.delete(this);
    this.listeners.clear();
  }

  private async save(): Promise<void> {
    const keys = this.state.snapshot.keys.slice();
    try {
      if (this.state.revision === null) await this.refreshRevision();
      this.state.revision = await this.port.write(keys, this.state.revision as Revision);
      this.removeSavedKeys(keys);
      this.state.saveError = null;
      this.commit({ error: null });
    } catch (error) {
      if (!(error instanceof AppFailure && error.appError.code === "conflict")) {
        this.failSave(error);
        return;
      }
      await this.saveAfterConflict();
    }
  }

  /** The file changed elsewhere: keep the saved list, put the newest choice first, and save again. */
  private async saveAfterConflict(): Promise<void> {
    try {
      const head = this.state.snapshot.keys[0];
      const fresh = await this.port.read();
      const keys = orderedKeys(head ? [head, ...fresh.keys] : fresh.keys);
      this.state.revision = await this.port.write(keys, fresh.revision);
      this.removeSavedKeys(keys);
      this.state.saveError = null;
      this.commit({
        keys: orderedKeys([...keys, ...this.state.pendingKeys, ...this.state.retainedKeys]),
        error: null,
      });
    } catch (error) {
      this.failSave(error);
    }
  }

  private async refreshRevision(): Promise<void> {
    const next = await this.port.read();
    this.state.revision = next.revision;
  }

  private removeSavedKeys(keys: readonly string[]): void {
    const saved = new Set(keys);
    this.state.pendingKeys = this.state.pendingKeys.filter((key) => !saved.has(key));
    this.state.retainedKeys = this.state.retainedKeys.filter((key) => !saved.has(key));
  }

  private failSave(error: unknown): void {
    this.state.retainedKeys = orderedKeys([...this.state.pendingKeys, ...this.state.retainedKeys]);
    this.state.pendingKeys = [];
    this.state.saveError = failureMessage(error, "The recent models could not be saved.");
    this.commit({ error: this.state.saveError });
  }

  private commit(patch: Partial<RecentModelsSnapshot>): void {
    this.state.snapshot = Object.freeze({ ...this.state.snapshot, ...patch });
    for (const instance of this.state.instances) instance.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.state.snapshot);
  }
}
