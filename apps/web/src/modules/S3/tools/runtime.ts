import type {
  AppError,
  ConfigEntry,
  ConfigWriteLayer,
  FolderPath,
  Revision,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { SettingsRuntime } from "../../S1/runtime";
import type {
  ApplyStatus,
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
  SettingsSectionDescriptor,
  SettingValue,
  StagedSettings,
  ValidationResult,
} from "../../S1/settings-kit";
import { commit as commitSection, stage as stageSection } from "../../S1/settings-kit";
import {
  isToolsPolicyConfigKey,
  projectToolsPolicy,
  TOOLS_SETTINGS_SECTIONS,
  type ToolsConfigSnapshot,
  type ToolsPolicySnapshot,
  type ToolsSectionId,
  type ToolsSettingKey,
  toolsSectionForKey,
} from "./policy";

function sectionId(descriptor: SettingsSectionDescriptor): ToolsSectionId {
  return descriptor.id as ToolsSectionId;
}

function sectionSnapshot(
  descriptor: SettingsSectionDescriptor,
  folder: FolderPath | null,
  revision: Revision,
  entries: readonly ConfigEntry[],
): ConfigSnapshot {
  const keys = new Set(descriptor.controls.map((control) => control.key));
  return Object.freeze({
    folder,
    revision,
    entries: Object.freeze(entries.filter((entry) => keys.has(entry.key))),
  });
}

/** Read all ten Tools sections through the one A1 ConfigStore list operation. */
export async function readToolsSettings(
  client: ConfigStoreClient,
  folder: FolderPath | null,
): Promise<ToolsConfigSnapshot> {
  const result = await client.list({ folder });
  const entries = Object.freeze(
    result.entries.filter((entry) => isToolsPolicyConfigKey(entry.key)),
  );
  const sections = {} as { [Section in ToolsSectionId]: ConfigSnapshot };
  for (const descriptor of TOOLS_SETTINGS_SECTIONS) {
    const id = sectionId(descriptor);
    sections[id] = sectionSnapshot(descriptor, folder, result.revision, entries);
  }
  return Object.freeze({
    folder,
    revision: result.revision,
    entries,
    sections: Object.freeze(sections) as Readonly<{ [Section in ToolsSectionId]: ConfigSnapshot }>,
  });
}

export type ToolsStagedSettings = {
  readonly snapshot: ToolsConfigSnapshot;
  readonly edits: Readonly<Partial<Record<ToolsSettingKey, SettingValue>>>;
};

export type ToolsStageResult =
  | { readonly ok: true; readonly state: ToolsStagedSettings }
  | { readonly ok: false; readonly validation: ValidationResult & { readonly valid: false } };

function editsForSection(
  descriptor: SettingsSectionDescriptor,
  edits: Readonly<Partial<Record<ToolsSettingKey, SettingValue>>>,
): Readonly<Record<string, SettingValue>> {
  const result: Record<string, SettingValue> = {};
  for (const control of descriptor.controls) {
    const value = edits[control.key as ToolsSettingKey];
    if (value !== undefined) result[control.key] = value;
  }
  return Object.freeze(result);
}

/** Validate and stage one dotted Tools key using S1.1's control grammar. */
export function stageToolsSetting(
  state: ToolsStagedSettings,
  key: ToolsSettingKey,
  value: SettingValue,
): ToolsStageResult {
  const descriptor = toolsSectionForKey(key);
  const current = {
    snapshot: state.snapshot.sections[sectionId(descriptor)],
    edits: editsForSection(descriptor, state.edits),
  } satisfies StagedSettings;
  const result = stageSection(descriptor, current, key, value);
  if (!result.ok) return result;
  return {
    ok: true,
    state: Object.freeze({
      snapshot: state.snapshot,
      edits: Object.freeze({ ...state.edits, [key]: value }),
    }),
  };
}

export type ToolsSaveResult = {
  readonly snapshot: ToolsConfigSnapshot;
  readonly entries: readonly ConfigEntry[];
  readonly revision: Revision;
  readonly status: ApplyStatus;
};

function statusRank(status: ToolsSaveResult["status"]): number {
  return {
    applied: 0,
    "session-only": 1,
    "reload-required": 2,
    "restart-required": 3,
    unsupported: 4,
  }[status];
}

function maxStatus(
  current: ToolsSaveResult["status"],
  next: ToolsSaveResult["status"],
): ToolsSaveResult["status"] {
  return statusRank(next) > statusRank(current) ? next : current;
}

/**
 * Persist staged Tools keys with A1's one-key CAS writes. A conflict is deliberately propagated so
 * the caller can reload or keep its staged values; this function never retries over newer data.
 */
export async function saveToolsSettings(
  client: ConfigStoreClient,
  state: ToolsStagedSettings,
  layer: ConfigWriteLayer,
): Promise<ToolsSaveResult> {
  let revision = state.snapshot.revision;
  let status: ToolsSaveResult["status"] = "applied";
  const entries: ConfigEntry[] = [];
  for (const descriptor of TOOLS_SETTINGS_SECTIONS) {
    const edits = editsForSection(descriptor, state.edits);
    if (Object.keys(edits).length === 0) continue;
    const currentSection = state.snapshot.sections[sectionId(descriptor)];
    const result = await commitSection(
      client,
      descriptor,
      {
        snapshot: sectionSnapshot(
          descriptor,
          currentSection.folder,
          revision,
          currentSection.entries,
        ),
        edits,
      },
      layer,
    );
    entries.push(...result.entries);
    revision = result.revision;
    status = maxStatus(status, result.status);
  }
  const snapshot =
    entries.length === 0 ? state.snapshot : await readToolsSettings(client, state.snapshot.folder);
  return Object.freeze({
    snapshot,
    entries: Object.freeze(entries),
    revision: snapshot.revision,
    status,
  });
}

export type ToolsSettingsStorePhase =
  | "idle"
  | "loading"
  | "ready"
  | "editing"
  | "saving"
  | "conflict"
  | "error";

export type ToolsSettingsStoreSnapshot = {
  readonly config: ToolsConfigSnapshot | null;
  readonly staged: ToolsStagedSettings | null;
  readonly policy: ToolsPolicySnapshot | null;
  readonly validation: Readonly<Record<string, ValidationResult>>;
  readonly phase: ToolsSettingsStorePhase;
  readonly error: AppError | null;
};

export type ToolsSettingsStoreListener = (snapshot: ToolsSettingsStoreSnapshot) => void;

function toAppError(error: unknown, fallback: string): AppError {
  if (error instanceof AppFailure) return error.appError;
  return new AppFailure({
    code: "internal",
    message: error instanceof Error && error.message ? error.message : fallback,
    retryable: true,
  }).appError;
}

/** Aggregate ConfigStore-backed Tools state while keeping S1.1 as the settings write grammar. */
export class ToolsSettingsStore {
  private readonly client: ConfigStoreClient;
  private readonly folder: FolderPath | null;
  private readonly layer: ConfigWriteLayer;
  private readonly listeners = new Set<ToolsSettingsStoreListener>();
  private current: ToolsSettingsStoreSnapshot = Object.freeze({
    config: null,
    staged: null,
    policy: null,
    validation: {},
    phase: "idle",
    error: null,
  });

  public constructor(
    client: ConfigStoreClient,
    options: { readonly folder: FolderPath | null; readonly layer: ConfigWriteLayer },
  ) {
    this.client = client;
    this.folder = options.folder;
    this.layer = options.layer;
  }

  public getSnapshot(): ToolsSettingsStoreSnapshot {
    return this.current;
  }

  public subscribe(listener: ToolsSettingsStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async read(): Promise<ToolsConfigSnapshot> {
    this.update({ phase: "loading", error: null });
    try {
      const config = await readToolsSettings(this.client, this.folder);
      const staged = Object.freeze({ snapshot: config, edits: {} });
      this.update({ config, staged, policy: projectToolsPolicy(config), phase: "ready" });
      return config;
    } catch (error) {
      this.update({ phase: "error", error: toAppError(error, "Reading Tools settings failed.") });
      throw error;
    }
  }

  public stage(key: ToolsSettingKey, value: SettingValue): ToolsStageResult {
    const staged = this.current.staged;
    if (!staged) {
      const validation = {
        valid: false as const,
        code: "not-ready",
        message: "Tools settings are still loading.",
      };
      this.update({ validation: { ...this.current.validation, [key]: validation } });
      return { ok: false, validation };
    }
    const result = stageToolsSetting(staged, key, value);
    if (!result.ok) {
      this.update({ validation: { ...this.current.validation, [key]: result.validation } });
      return result;
    }
    const validation = { ...this.current.validation };
    delete validation[key];
    this.update({ staged: result.state, validation, phase: "editing", error: null });
    return result;
  }

  public cancel(): void {
    const config = this.current.config;
    if (!config) return;
    const staged = Object.freeze({ snapshot: config, edits: {} });
    this.update({ staged, validation: {}, phase: "ready", error: null });
  }

  public async save(): Promise<ToolsSaveResult> {
    const staged = this.current.staged;
    if (!staged) {
      throw new AppFailure({
        code: "unavailable",
        message: "Tools settings are not loaded yet.",
        retryable: false,
      });
    }
    if (this.current.phase === "conflict") {
      throw new AppFailure({
        code: "invalid_args",
        message: "Resolve the Tools settings conflict before saving.",
        retryable: false,
      });
    }
    this.update({ phase: "saving", error: null });
    try {
      const result = await saveToolsSettings(this.client, staged, this.layer);
      const next = Object.freeze({ snapshot: result.snapshot, edits: {} });
      this.update({
        config: result.snapshot,
        staged: next,
        policy: projectToolsPolicy(result.snapshot),
        phase: "ready",
        validation: {},
        error: null,
      });
      return result;
    } catch (error) {
      const appError = toAppError(error, "Saving Tools settings failed.");
      if (appError.code === "conflict") {
        try {
          await this.refresh();
          this.update({ error: appError });
        } catch (refreshError) {
          this.update({
            phase: "error",
            error: toAppError(refreshError, "Refreshing Tools settings after a conflict failed."),
          });
        }
      } else {
        this.update({ phase: "error", error: appError });
      }
      throw error;
    }
  }

  /** Re-read the scope and preserve staged edits as a conflict when they exist. */
  public async refresh(): Promise<ToolsConfigSnapshot> {
    const remote = await readToolsSettings(this.client, this.folder);
    const staged = this.current.staged;
    if (staged && Object.keys(staged.edits).length > 0) {
      this.update({
        config: remote,
        staged: Object.freeze({ snapshot: remote, edits: staged.edits }),
        policy: projectToolsPolicy(remote),
        phase: "conflict",
        error: null,
      });
    } else {
      this.update({
        config: remote,
        staged: Object.freeze({ snapshot: remote, edits: {} }),
        policy: projectToolsPolicy(remote),
        phase: "ready",
        error: null,
      });
    }
    return remote;
  }

  public async resolveConflict(choice: "reload" | "keep-mine"): Promise<void> {
    if (this.current.phase !== "conflict") return;
    const remote = await readToolsSettings(this.client, this.folder);
    const edits = choice === "reload" ? {} : (this.current.staged?.edits ?? {});
    this.update({
      config: remote,
      staged: Object.freeze({ snapshot: remote, edits }),
      policy: projectToolsPolicy(remote),
      phase: choice === "reload" ? "ready" : "editing",
      validation: {},
      error: null,
    });
  }

  private update(patch: Partial<ToolsSettingsStoreSnapshot>): void {
    this.current = Object.freeze({ ...this.current, ...patch });
    for (const listener of this.listeners) listener(this.current);
  }
}

export type ToolsSectionRuntime = {
  readonly descriptor: SettingsSectionDescriptor;
  readonly runtime: SettingsRuntime;
};

/** Create one S1.2 runtime per Tools section for S1.3's section surface. */
export function createToolsSectionRuntimes(
  client: ConfigStoreClient,
  source: ConfigChangeSource,
  options: { readonly folder: FolderPath | null; readonly layer: ConfigWriteLayer },
): readonly ToolsSectionRuntime[] {
  return Object.freeze(
    TOOLS_SETTINGS_SECTIONS.map((descriptor) => ({
      descriptor,
      runtime: new SettingsRuntime(client, source, {
        descriptor,
        folder: options.folder,
        layer: options.layer,
      }),
    })),
  );
}
