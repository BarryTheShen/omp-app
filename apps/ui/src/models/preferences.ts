import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  applyModelPreferenceChange,
  ModelPreferenceStore,
  ModelPreferences,
} from "@omp-app/contracts";
import { follow } from "../follow";
import { lastSeen } from "../lastSeen";

export type PreferencesState =
  | { readonly kind: "loading" }
  /** The server keeps no stars or hidden models (it is older than the menu's), or could not read its file. */
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "ready"; readonly preferences: ModelPreferences };

/** The stars and hidden models as this browser saw them last, so a reload shows them at once. */
const kept = lastSeen<ModelPreferences>("model-preferences", (stored) => {
  const parsed = ModelPreferences.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
});

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/**
 * The model menu's stars and hidden models on one server, for every pane of the page. They are the server's, so every
 * device lists the models the same way: read once, then kept current by the server's `changed` events (another
 * device's change shows here too). A change shows at once and is then saved; one the server refuses is undone.
 */
export class ModelPreferencesStore {
  readonly #client: AppClient;
  readonly #listeners = new Set<() => void>();
  #state: PreferencesState;

  constructor(client: AppClient) {
    this.#client = client;
    const saved = kept.get();
    this.#state = saved === undefined ? { kind: "loading" } : { kind: "ready", preferences: saved };
    follow(client.subscribe(ModelPreferenceStore, "changed"), (preferences) =>
      this.#adopt(preferences),
    );
    void this.#read();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): PreferencesState => this.#state;

  /** Stars or unstars, hides or shows a model (`provider/id`). Rejects when the server could not save it. */
  async change(model: string, change: { readonly favorite?: boolean; readonly hidden?: boolean }) {
    const state = this.#state;
    if (state.kind !== "ready")
      throw new Error("This app server keeps no stars or hidden models yet.");
    this.#set({
      kind: "ready",
      preferences: {
        ...applyModelPreferenceChange(state.preferences, model, change),
        revision: state.preferences.revision,
      },
    });
    const port = this.#client.port(ModelPreferenceStore);
    const save = (revision: string) => port.set({ model, ...change, expectedRevision: revision });
    try {
      let saved: ModelPreferences;
      try {
        saved = await save(state.preferences.revision);
      } catch (failure) {
        // Another device (or another change from here) came first: apply this one to what is saved now.
        if (!(failure instanceof AppFailure && failure.appError.code === "conflict")) throw failure;
        saved = await save((await port.read({})).revision);
      }
      this.#adopt(saved);
    } catch (failure) {
      await this.#read();
      throw failure;
    }
  }

  async #read(): Promise<void> {
    try {
      this.#adopt(await this.#client.port(ModelPreferenceStore).read({}));
    } catch (failure) {
      if (this.#state.kind !== "ready")
        this.#set({ kind: "unavailable", reason: failureText(failure) });
    }
  }

  #adopt(preferences: ModelPreferences): void {
    kept.set(preferences);
    this.#set({ kind: "ready", preferences });
  }

  #set(state: PreferencesState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

const stores = new WeakMap<AppClient, ModelPreferencesStore>();

/** The stars and hidden models of the server `client` talks to, one store for the whole page. */
export function modelPreferencesFor(client: AppClient): ModelPreferencesStore {
  let store = stores.get(client);
  if (store === undefined) {
    store = new ModelPreferencesStore(client);
    stores.set(client, store);
  }
  return store;
}
