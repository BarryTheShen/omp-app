import type { AppClient } from "@omp-app/client";
import {
  type AppError,
  AppFailure,
  type ConfigChanged,
  ConfigStore,
  type ConfigWriteLayer,
  type FolderPath,
} from "@omp-app/contracts";
import { useCallback, useSyncExternalStore } from "react";
import {
  type ApplyStatus,
  type ConfigChangeSource,
  type ConfigSnapshot,
  type ConfigStoreClient,
  commit as commitSection,
  type PreviewResult,
  preview as previewEdit,
  readSection,
  type SettingsSectionDescriptor,
  type StagedSettings,
  type StageResult,
  stage as stageEdit,
  type ValidationResult,
} from "../settings-kit";

export type SettingsRuntimePhase =
  | "idle"
  | "loading"
  | "ready"
  | "editing"
  | "saving"
  | "conflict"
  | "error";

export type ConflictChoice = "reload" | "keep-mine";

export type SettingsRuntimeConflict = {
  readonly local: StagedSettings;
  readonly remote: ConfigSnapshot;
  readonly changedKeys: readonly string[];
};

export type SettingsRuntimeSnapshot = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly folder: FolderPath | null;
  readonly layer: ConfigWriteLayer;
  readonly config: ConfigSnapshot | null;
  readonly staged: StagedSettings | null;
  readonly validation: Readonly<Record<string, ValidationResult>>;
  readonly phase: SettingsRuntimePhase;
  readonly conflict: SettingsRuntimeConflict | null;
  readonly error: AppError | null;
  readonly applyStatus: ApplyStatus | null;
  readonly lastChange: ConfigChanged | null;
};

export type SettingsRuntimeListener = (snapshot: SettingsRuntimeSnapshot) => void;

export type SettingsRuntimeOptions = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly folder: FolderPath | null;
  readonly layer: ConfigWriteLayer;
};

function asFailure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: error instanceof Error && error.message.length > 0 ? error.message : fallback,
      retryable: true,
    },
    { cause: error },
  );
}

function unavailable(message: string): AppFailure {
  return new AppFailure({ code: "unavailable", message, retryable: false });
}

function invalid(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function configStreamScope(folder: FolderPath | null): string {
  // A1.9's scoped binding maps the literal global scope to ConfigStore's null folder.
  return folder ?? "global";
}

function emptyValidation(message: string): {
  readonly ok: false;
  readonly validation: ValidationResult & { readonly valid: false };
} {
  return { ok: false, validation: { valid: false, code: "not-ready", message } };
}

/** Real A0.8 ConfigStore adapter; all persistence remains behind the typed A1 port. */
export function createConfigStoreClient(client: AppClient): ConfigStoreClient {
  return client.port(ConfigStore);
}

/**
 * Real A0.8/A1.9 changed-stream adapter. The scope is deliberately `global` for a null folder;
 * using an omitted scope would bind to the wrong activity stream and miss global changes.
 */
export function createConfigChangeSource(
  client: AppClient,
  folder: FolderPath | null,
  onError?: (error: AppFailure) => void,
): ConfigChangeSource {
  return {
    subscribe(listener) {
      let active = true;
      let removeListener: (() => void) | undefined;
      let subscription: { readonly unsubscribe: () => Promise<void> } | undefined;
      let pending: Promise<void>;
      try {
        pending = client
          .subscribe(ConfigStore, "changed", { scope: configStreamScope(folder) })
          .then((next) => {
            subscription = next;
            if (!active) {
              void next.unsubscribe();
              return;
            }
            removeListener = next.onEvent((change) => listener(change));
          })
          .catch((error: unknown) => {
            if (active) onError?.(asFailure(error, "The settings change stream failed."));
          });
      } catch (error) {
        const failure = asFailure(error, "The settings change stream failed.");
        if (active) onError?.(failure);
        pending = Promise.resolve();
      }
      return () => {
        active = false;
        removeListener?.();
        void pending.then(() => subscription?.unsubscribe()).catch(() => undefined);
      };
    },
  };
}

/**
 * Owns one settings section's browser lifecycle: read, staged edits, one-key CAS save, external
 * change reconciliation and explicit conflict choice. No file, YAML, env or browser storage access
 * lives here.
 */
export class SettingsRuntime {
  private readonly client: ConfigStoreClient;
  private readonly source: ConfigChangeSource;
  private readonly listeners = new Set<SettingsRuntimeListener>();
  private readonly descriptor: SettingsSectionDescriptor;
  private readonly folder: FolderPath | null;
  private readonly layer: ConfigWriteLayer;
  private snapshot: SettingsRuntimeSnapshot;
  private unsubscribeChanged: (() => void) | undefined;
  private operation = 0;
  private writing = false;
  private disposed = false;

  public constructor(
    client: ConfigStoreClient,
    source: ConfigChangeSource,
    options: SettingsRuntimeOptions,
  ) {
    this.client = client;
    this.source = source;
    this.descriptor = options.descriptor;
    this.folder = options.folder;
    this.layer = options.layer;
    this.snapshot = Object.freeze({
      descriptor: this.descriptor,
      folder: this.folder,
      layer: this.layer,
      config: null,
      staged: null,
      validation: {},
      phase: "idle",
      conflict: null,
      error: null,
      applyStatus: null,
      lastChange: null,
    });
    this.unsubscribeChanged = this.source.subscribe((change) => {
      void this.handleChanged(change);
    });
  }

  public getSnapshot(): SettingsRuntimeSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: SettingsRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async read(): Promise<ConfigSnapshot> {
    const operation = ++this.operation;
    this.commit({ phase: "loading", error: null, conflict: null });
    try {
      const config = await readSection(this.client, this.descriptor, this.folder);
      if (operation !== this.operation || this.disposed) return config;
      this.commit({
        config,
        staged: { snapshot: config, edits: {} },
        validation: {},
        phase: "ready",
        conflict: null,
        error: null,
        applyStatus: null,
        lastChange: null,
      });
      return config;
    } catch (error) {
      const failure = asFailure(error, "Reading settings failed.");
      if (operation === this.operation) this.commit({ phase: "error", error: failure.appError });
      throw failure;
    }
  }

  public stage(key: string, value: StagedSettings["edits"][string]): StageResult {
    const staged = this.snapshot.staged;
    if (!staged) return emptyValidation("Settings are still loading.");
    const result = stageEdit(this.descriptor, staged, key, value);
    if (!result.ok) {
      this.commit({
        validation: { ...this.snapshot.validation, [key]: result.validation },
        error: null,
      });
      return result;
    }
    const validation = { ...this.snapshot.validation };
    delete validation[key];
    this.commit({
      staged: result.state,
      validation,
      phase: "editing",
      error: null,
      conflict: null,
    });
    return result;
  }

  public preview(key: string): PreviewResult {
    const staged = this.snapshot.staged;
    if (!staged) return emptyValidation("Settings are still loading.");
    return previewEdit(this.descriptor, staged, key);
  }

  public cancel(): void {
    const config = this.snapshot.config;
    if (!config) return;
    this.commit({
      staged: { snapshot: config, edits: {} },
      validation: {},
      phase: "ready",
      conflict: null,
      error: null,
    });
  }

  public async save(): Promise<Awaited<ReturnType<typeof commitSection>>> {
    const staged = this.snapshot.staged;
    if (!staged) throw unavailable("Settings are not loaded yet.");
    if (this.snapshot.conflict) {
      throw invalid("Resolve the settings conflict before saving.");
    }
    if (Object.keys(staged.edits).length === 0) {
      return { entries: [], revision: staged.snapshot.revision, status: "applied" };
    }
    this.writing = true;
    this.commit({ phase: "saving", error: null });
    try {
      const result = await commitSection(this.client, this.descriptor, staged, this.layer);
      const config = await readSection(this.client, this.descriptor, this.folder);
      this.writing = false;
      this.commit({
        config,
        staged: { snapshot: config, edits: {} },
        validation: {},
        phase: "ready",
        conflict: null,
        error: null,
        applyStatus: result.status,
        lastChange: null,
      });
      return result;
    } catch (error) {
      this.writing = false;
      const failure = asFailure(error, "Saving settings failed.");
      if (failure.appError.code === "conflict") {
        await this.enterConflict(staged, failure.appError);
      } else {
        this.commit({ phase: "error", error: failure.appError });
      }
      throw failure;
    }
  }

  public resolveConflict(choice: ConflictChoice): void {
    const conflict = this.snapshot.conflict;
    if (!conflict) return;
    const staged =
      choice === "reload"
        ? { snapshot: conflict.remote, edits: {} }
        : { snapshot: conflict.remote, edits: { ...conflict.local.edits } };
    this.commit({
      config: conflict.remote,
      staged,
      validation: {},
      phase: choice === "reload" ? "ready" : "editing",
      conflict: null,
      error: null,
    });
  }

  public async retry(): Promise<ConfigSnapshot> {
    return this.read();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeChanged?.();
    this.unsubscribeChanged = undefined;
    this.listeners.clear();
  }

  private async handleChanged(change: ConfigChanged): Promise<void> {
    if (this.disposed) return;
    if (this.writing) {
      return;
    }
    const operation = ++this.operation;
    try {
      const remote = await readSection(this.client, this.descriptor, this.folder);
      if (operation !== this.operation || this.disposed) return;
      const staged = this.snapshot.staged;
      if (staged && Object.keys(staged.edits).length > 0) {
        this.commit({
          config: remote,
          phase: "conflict",
          conflict: {
            local: staged,
            remote,
            changedKeys: [change.key],
          },
          error: null,
          lastChange: change,
        });
      } else {
        this.commit({
          config: remote,
          staged: { snapshot: remote, edits: {} },
          phase: "ready",
          conflict: null,
          error: null,
          lastChange: change,
        });
      }
    } catch (error) {
      const failure = asFailure(error, "Reading an external settings change failed.");
      this.commit({ phase: "error", error: failure.appError, lastChange: change });
    }
  }

  private async enterConflict(local: StagedSettings, error: AppError): Promise<void> {
    try {
      const remote = await readSection(this.client, this.descriptor, this.folder);
      this.commit({
        config: remote,
        phase: "conflict",
        conflict: {
          local,
          remote,
          changedKeys: Object.keys(local.edits),
        },
        error,
      });
    } catch (readError) {
      const failure = asFailure(readError, "Reloading settings after a conflict failed.");
      this.commit({ phase: "error", error: failure.appError });
    }
  }

  public fail(error: AppFailure): void {
    if (!this.disposed) this.commit({ phase: "error", error: error.appError });
  }

  private commit(patch: Partial<SettingsRuntimeSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

/** React bridge for S1.3 and later settings surfaces; the runtime remains the state authority. */
export function useSettingsRuntime(runtime: SettingsRuntime): SettingsRuntimeSnapshot {
  const subscribe = useCallback(
    (listener: SettingsRuntimeListener) => runtime.subscribe(listener),
    [runtime],
  );
  const getSnapshot = useCallback(() => runtime.getSnapshot(), [runtime]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Creates the real runtime over A0.8's AppClient and the A1.4 ConfigStore port. */
export function createSettingsRuntime(
  client: AppClient,
  options: SettingsRuntimeOptions,
): SettingsRuntime {
  let runtime: SettingsRuntime | undefined;
  const source = createConfigChangeSource(client, options.folder, (error) => runtime?.fail(error));
  runtime = new SettingsRuntime(createConfigStoreClient(client), source, options);
  return runtime;
}
