import type { AppClient } from "@omp-app/client";
import type {
  AppError,
  ConfigEntry,
  ConfigListResult,
  FolderPath,
  JsonValue,
  Revision,
} from "@omp-app/contracts";
import { AppFailure, ConfigStore } from "@omp-app/contracts";
import type {
  ModelRoleSelector,
  ModelSettings,
  ModelSettingsLayer,
  ModelSettingsPort,
  ModelSettingsSnapshot,
} from "../contract";
import {
  ModelSettingsLayer as ModelSettingsLayerSchema,
  ModelSettings as ModelSettingsSchema,
} from "../contract";

const MODEL_SETTING_KEYS = [
  "enabledModels",
  "enabledProviders",
  "disabledProviders",
  "modelRoleStorage",
  "modelRoles",
  "modelPresets",
  "modelTags",
  "modelProviderOrder",
  "cycleOrder",
  "defaultThinkingLevel",
] as const satisfies readonly (keyof ModelSettings)[];
type ModelSettingKey = (typeof MODEL_SETTING_KEYS)[number];

const DEFAULT_SETTINGS: ModelSettings = {
  enabledModels: [],
  enabledProviders: [],
  disabledProviders: [],
  modelRoleStorage: "global",
  modelRoles: {},
  modelPresets: {},
  modelTags: {},
  modelProviderOrder: [],
  cycleOrder: ["smol", "default", "slow"],
  defaultThinkingLevel: "auto",
};

function failure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: error instanceof Error ? error.message : fallback,
      retryable: true,
    },
    { cause: error },
  );
}

function cloneSettings(settings: ModelSettings): ModelSettings {
  return {
    enabledModels: [...settings.enabledModels],
    enabledProviders: [...settings.enabledProviders],
    disabledProviders: [...settings.disabledProviders],
    modelRoleStorage: settings.modelRoleStorage,
    modelRoles: { ...settings.modelRoles },
    modelPresets: Object.fromEntries(
      Object.entries(settings.modelPresets).map(([name, preset]) => [
        name,
        { ...preset, modelRoles: { ...preset.modelRoles } },
      ]),
    ),
    modelTags: Object.fromEntries(
      Object.entries(settings.modelTags).map(([name, tag]) => [name, { ...tag }]),
    ),
    modelProviderOrder: [...settings.modelProviderOrder],
    cycleOrder: [...settings.cycleOrder],
    ...(settings.defaultThinkingLevel
      ? { defaultThinkingLevel: settings.defaultThinkingLevel }
      : {}),
  };
}
/** omp's preset name rule (model-presets.ts:24-25 at v18.6.1): a letter, then letters, digits, `-` or `_`. */
const PRESET_NAME_PATTERN = /^[a-zA-Z][\w-]*$/;

export const PRESET_NAME_RULE =
  "A preset name starts with a letter, then uses only letters, digits, - or _.";

export function isValidPresetName(name: string): boolean {
  return PRESET_NAME_PATTERN.test(name);
}

/** Whether two settings hold the same values, whatever order their keys were written in. */
function sameSettings(left: ModelSettings, right: ModelSettings): boolean {
  return JSON.stringify(sortedKeys(left)) === JSON.stringify(sortedKeys(right));
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortedKeys(record[key])]),
  );
}

function selectorText(selector: ModelRoleSelector): string {
  return typeof selector === "string" ? selector : `${selector.provider}/${selector.modelId}`;
}

function emptySnapshot(layer: ModelSettingsLayer): ModelSettingsSnapshot {
  return {
    settings: cloneSettings(DEFAULT_SETTINGS),
    layer,
    revision: "model-settings-initial",
    error: null,
  };
}

function entryValue(entry: ConfigEntry | undefined): unknown {
  if (!entry || entry.secret) return undefined;
  return entry.value;
}

function settingFromEntries(entries: ConfigEntry[]): ModelSettings {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const candidate = {
    enabledModels: entryValue(byKey.get("enabledModels")) ?? DEFAULT_SETTINGS.enabledModels,
    enabledProviders:
      entryValue(byKey.get("enabledProviders")) ?? DEFAULT_SETTINGS.enabledProviders,
    disabledProviders:
      entryValue(byKey.get("disabledProviders")) ?? DEFAULT_SETTINGS.disabledProviders,
    modelRoleStorage:
      entryValue(byKey.get("modelRoleStorage")) ?? DEFAULT_SETTINGS.modelRoleStorage,
    modelRoles: entryValue(byKey.get("modelRoles")) ?? DEFAULT_SETTINGS.modelRoles,
    modelPresets: entryValue(byKey.get("modelPresets")) ?? DEFAULT_SETTINGS.modelPresets,
    modelTags: entryValue(byKey.get("modelTags")) ?? DEFAULT_SETTINGS.modelTags,
    modelProviderOrder:
      entryValue(byKey.get("modelProviderOrder")) ?? DEFAULT_SETTINGS.modelProviderOrder,
    cycleOrder: entryValue(byKey.get("cycleOrder")) ?? DEFAULT_SETTINGS.cycleOrder,
    ...(entryValue(byKey.get("defaultThinkingLevel")) !== undefined
      ? { defaultThinkingLevel: entryValue(byKey.get("defaultThinkingLevel")) }
      : {}),
  };
  const parsed = ModelSettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AppFailure({
      code: "invalid_args",
      message: "The persisted model settings are invalid.",
      retryable: false,
    });
  }
  return parsed.data;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (typeof value === "object" && value !== null) {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) result[key] = jsonValue(child);
    return result;
  }
  throw new AppFailure({
    code: "invalid_args",
    message: "Model settings contain a value that cannot be persisted.",
    retryable: false,
  });
}

function changedKeys(before: ModelSettings, after: ModelSettings): readonly ModelSettingKey[] {
  return MODEL_SETTING_KEYS.filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

function scopeFor(folder: FolderPath | null): string | undefined {
  return folder ?? undefined;
}

export interface ModelSettingsAdapterOptions {
  readonly folder: FolderPath | null;
  readonly layer: ModelSettingsLayer;
}

/** Real A1.4-backed model settings store. It writes only changed top-level keys with CAS. */
export function createConfigModelSettingsPort(
  client: AppClient,
  options: ModelSettingsAdapterOptions,
): ModelSettingsPort {
  const config = client.port(ConfigStore);
  let previous = cloneSettings(DEFAULT_SETTINGS);
  let previousRevision: Revision = "model-settings-initial";
  const disposed = false;
  const subscribers = new Set<(snapshot: ModelSettingsSnapshot) => void>();

  const read = async (): Promise<ModelSettingsSnapshot> => {
    try {
      const result: ConfigListResult = await config.list({
        folder: options.layer === "project" ? options.folder : null,
      });
      const settings = settingFromEntries(result.entries);
      previous = cloneSettings(settings);
      previousRevision = result.revision;
      return { settings, layer: options.layer, revision: result.revision, error: null };
    } catch (error) {
      const appFailure = failure(error, "Reading model settings failed.");
      return {
        ...emptySnapshot(options.layer),
        revision: previousRevision,
        error: appFailure.appError,
      };
    }
  };

  const write = async (
    settings: ModelSettings,
    expectedRevision: Revision,
  ): Promise<ModelSettingsSnapshot> => {
    const parsed = ModelSettingsSchema.parse(settings);
    const keys = changedKeys(previous, parsed);
    if (keys.length === 0) {
      return {
        settings: cloneSettings(parsed),
        layer: options.layer,
        revision: expectedRevision,
        error: null,
      };
    }
    let revision = expectedRevision;
    try {
      for (const key of keys) {
        const result = await config.write({
          key,
          layer: options.layer,
          folder: options.layer === "project" ? options.folder : null,
          value: { secret: false, value: jsonValue(parsed[key]) },
          expectedRevision: revision,
        });
        revision = result.revision;
      }
      previous = cloneSettings(parsed);
      previousRevision = revision;
      return { settings: cloneSettings(parsed), layer: options.layer, revision, error: null };
    } catch (error) {
      throw failure(error, "Writing model settings failed.");
    }
  };

  return {
    getSnapshot: () => ({
      settings: cloneSettings(previous),
      layer: options.layer,
      revision: previousRevision,
      error: null,
    }),
    read,
    write,
    subscribe: (listener) => {
      subscribers.add(listener);
      let active = true;
      let remove: (() => void) | undefined;
      let subscription: { readonly unsubscribe: () => Promise<void> } | undefined;
      const pending = client
        .subscribe(ConfigStore, "changed", { scope: scopeFor(options.folder) })
        .then((next) => {
          subscription = next;
          if (!active) {
            void next.unsubscribe();
            return;
          }
          remove = next.onEvent((change) => {
            if (!MODEL_SETTING_KEYS.includes(change.key as ModelSettingKey)) return;
            void read().then((snapshot) => {
              if (!disposed) for (const current of subscribers) current(snapshot);
            });
          });
        })
        .catch(() => undefined);
      return () => {
        active = false;
        subscribers.delete(listener);
        remove?.();
        void pending.then(() => subscription?.unsubscribe()).catch(() => undefined);
      };
    },
  };
}

export type RoleStoreStatus = "idle" | "loading" | "ready" | "saving" | "conflict" | "error";

export interface RoleStoreSnapshot {
  readonly settings: ModelSettings;
  readonly layer: ModelSettingsLayer;
  readonly revision: Revision;
  readonly status: RoleStoreStatus;
  readonly error: AppError | null;
}

export type RoleStoreListener = (snapshot: RoleStoreSnapshot) => void;

/** Browser role/fallback state machine over A1.4's ConfigStore-backed ModelSettingsPort. */
export class ModelRoleStore {
  private readonly port: ModelSettingsPort;
  private readonly listeners = new Set<RoleStoreListener>();
  private readonly stopPortSubscription: () => void;
  private snapshot: RoleStoreSnapshot;

  public constructor(port: ModelSettingsPort) {
    this.port = port;
    const initial = port.getSnapshot();
    this.snapshot = {
      settings: cloneSettings(initial.settings),
      layer: initial.layer,
      revision: initial.revision,
      status: initial.error ? "error" : "idle",
      error: initial.error,
    };
    this.stopPortSubscription = port.subscribe((next) => {
      if (next.revision === this.snapshot.revision && next.error === null) return;
      this.commit({
        settings: cloneSettings(next.settings),
        layer: next.layer,
        revision: next.revision,
        status: next.error ? "error" : "ready",
        error: next.error,
      });
    });
  }

  public getSnapshot(): RoleStoreSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: RoleStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async read(): Promise<RoleStoreSnapshot> {
    this.commit({ status: "loading", error: null });
    const next = await this.port.read();
    this.commit({
      settings: cloneSettings(next.settings),
      layer: next.layer,
      revision: next.revision,
      status: next.error ? "error" : "ready",
      error: next.error,
    });
    return this.snapshot;
  }

  public async assignRole(role: string, selector: ModelRoleSelector): Promise<RoleStoreSnapshot> {
    const name = role.trim();
    if (!name)
      throw new AppFailure({
        code: "invalid_args",
        message: "Role name is required.",
        retryable: false,
      });
    return this.mutate((settings) => ({
      ...settings,
      modelRoles: { ...settings.modelRoles, [name]: selector },
    }));
  }

  public async unassignRole(role: string): Promise<RoleStoreSnapshot> {
    const name = role.trim();
    return this.mutate((settings) => {
      const modelRoles = { ...settings.modelRoles };
      delete modelRoles[name];
      return { ...settings, modelRoles };
    });
  }

  public async setCycleOrder(order: readonly string[]): Promise<RoleStoreSnapshot> {
    const normalized = [...new Set(order.map((role) => role.trim()).filter(Boolean))];
    if (normalized.length === 0) {
      throw new AppFailure({
        code: "invalid_args",
        message: "Cycle order cannot be empty.",
        retryable: false,
      });
    }
    return this.mutate((settings) => ({ ...settings, cycleOrder: normalized }));
  }

  public async moveCycleRole(role: string, direction: -1 | 1): Promise<RoleStoreSnapshot> {
    const order = [...this.snapshot.settings.cycleOrder];
    const index = order.indexOf(role);
    if (index < 0) return this.snapshot;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= order.length) return this.snapshot;
    const current = order[index];
    const target = order[nextIndex];
    if (!current || !target) return this.snapshot;
    order[index] = target;
    order[nextIndex] = current;
    return this.setCycleOrder(order);
  }
  public async savePreset(name: string): Promise<RoleStoreSnapshot> {
    const presetName = name.trim();
    if (!presetName) {
      throw new AppFailure({
        code: "invalid_args",
        message: "Preset name is required.",
        retryable: false,
      });
    }
    if (!isValidPresetName(presetName)) {
      throw new AppFailure({ code: "invalid_args", message: PRESET_NAME_RULE, retryable: false });
    }
    return this.mutate((settings) => ({
      ...settings,
      modelPresets: {
        ...settings.modelPresets,
        [presetName]: {
          modelRoles: Object.fromEntries(
            Object.entries(settings.modelRoles).map(([role, selector]) => [
              role,
              selectorText(selector),
            ]),
          ),
          ...(settings.defaultThinkingLevel
            ? { defaultThinkingLevel: settings.defaultThinkingLevel }
            : {}),
        },
      },
    }));
  }

  public async deletePreset(name: string): Promise<RoleStoreSnapshot> {
    return this.mutate((settings) => {
      const modelPresets = { ...settings.modelPresets };
      delete modelPresets[name];
      return { ...settings, modelPresets };
    });
  }

  public async switchPreset(name: string): Promise<RoleStoreSnapshot> {
    const preset = this.snapshot.settings.modelPresets[name];
    if (!preset) {
      throw new AppFailure({
        code: "not_found",
        message: `Model preset '${name}' was not found.`,
        retryable: false,
      });
    }
    return this.mutate((settings) => {
      const next = { ...settings, modelRoles: { ...preset.modelRoles } };
      // As omp's writePresetRoles does (model-presets.ts:261-289): a preset without a level keeps the saved one.
      if (preset.defaultThinkingLevel) next.defaultThinkingLevel = preset.defaultThinkingLevel;
      return next;
    });
  }

  public dispose(): void {
    this.stopPortSubscription();
    this.listeners.clear();
  }

  private async mutate(
    update: (settings: ModelSettings) => ModelSettings,
  ): Promise<RoleStoreSnapshot> {
    this.commit({ status: "saving", error: null });
    return this.attempt(
      update,
      cloneSettings(this.snapshot.settings),
      this.snapshot.revision,
      true,
    );
  }

  /**
   * Writes `update` applied to `base`. A conflict is answered once, and only when the model settings saved
   * now are the ones `base` holds: the file then moved in another part (the app keeps its recent models in
   * the same ConfigStore, and each write moves the revision that covers every layer), so the same change is
   * applied to what is saved now. Settings changed elsewhere are shown as a conflict, and nothing is overwritten.
   */
  private async attempt(
    update: (settings: ModelSettings) => ModelSettings,
    base: ModelSettings,
    expectedRevision: Revision,
    mayRetry: boolean,
  ): Promise<RoleStoreSnapshot> {
    try {
      const next = await this.port.write(update(cloneSettings(base)), expectedRevision);
      this.commit({
        settings: cloneSettings(next.settings),
        layer: next.layer,
        revision: next.revision,
        status: next.error ? "error" : "ready",
        error: next.error,
      });
      return this.snapshot;
    } catch (error) {
      const appFailure = failure(error, "Saving model roles failed.");
      if (appFailure.appError.code !== "conflict") {
        this.commit({ status: "error", error: appFailure.appError });
        throw appFailure;
      }
      const current = await this.port.read();
      if (mayRetry && current.error === null && sameSettings(current.settings, base)) {
        return this.attempt(update, current.settings, current.revision, false);
      }
      this.commit({
        settings: cloneSettings(current.settings),
        layer: current.layer,
        revision: current.revision,
        status: "conflict",
        error: appFailure.appError,
      });
      throw appFailure;
    }
  }

  private commit(patch: Partial<RoleStoreSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

export function roleStorageLayer(value: unknown): ModelSettingsLayer {
  return ModelSettingsLayerSchema.parse(value);
}
