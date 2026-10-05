import type {
  CapabilityKey,
  ConfigChanged,
  ConfigEntry,
  ConfigKey,
  ConfigStore,
  ConfigWriteLayer,
  ConfigWriteValue,
  DescriptorId,
  FolderPath,
  InventoryId,
  JsonValue,
  PortClient,
  Revision,
  SettingSection,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";

export type SettingControlKind =
  | "boolean"
  | "enum"
  | "number"
  | "duration"
  | "text"
  | "multiline"
  | "path"
  | "list"
  | "secret";

export type SettingValue =
  | { readonly secret: false; readonly value: JsonValue }
  | { readonly secret: true; readonly action: "set"; readonly value: string }
  | { readonly secret: true; readonly action: "unset" };

export type SettingOption = { readonly value: JsonValue; readonly label: string };

export type ValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly message: string; readonly code?: string };

export type PreviewPatch = {
  readonly key: ConfigKey;
  readonly value: JsonValue | { readonly secret: true; readonly isSet: boolean };
  readonly description?: string;
};

export type ApplyBoundary = "live" | "session" | "reload" | "restart" | "unsupported";

export type SettingControl = {
  readonly key: ConfigKey;
  readonly label: string;
  readonly description?: string;
  readonly kind: SettingControlKind;
  readonly secret: boolean;
  readonly options?: readonly SettingOption[];
  readonly validate: (value: SettingValue, snapshot: ConfigSnapshot) => ValidationResult;
  readonly apply: ApplyBoundary;
  readonly preview?: (value: SettingValue, snapshot: ConfigSnapshot) => PreviewPatch | null;
};

export type SettingsSectionDescriptor = {
  readonly id: DescriptorId;
  readonly section: SettingSection;
  readonly title: string;
  readonly inventory: readonly InventoryId[];
  readonly controls: readonly SettingControl[];
  readonly requires: readonly CapabilityKey[];
};

export type ConfigSnapshot = {
  readonly folder: FolderPath | null;
  readonly revision: Revision;
  readonly entries: readonly ConfigEntry[];
};

export type StagedSettings = {
  readonly snapshot: ConfigSnapshot;
  readonly edits: Readonly<Record<string, SettingValue>>;
};

export type StageResult =
  | { readonly ok: true; readonly state: StagedSettings }
  | { readonly ok: false; readonly validation: ValidationResult & { readonly valid: false } };

export type PreviewResult =
  | { readonly ok: true; readonly patch: PreviewPatch | null }
  | { readonly ok: false; readonly validation: ValidationResult & { readonly valid: false } };

export type ApplyStatus =
  | "applied"
  | "session-only"
  | "reload-required"
  | "restart-required"
  | "unsupported";

export type CommitResult = {
  readonly entries: readonly ConfigEntry[];
  readonly revision: Revision;
  readonly status: ApplyStatus;
};

export type ConfigStoreClient = Pick<PortClient<typeof ConfigStore>, "read" | "list" | "write">;

export type ConfigChangeSource = {
  readonly subscribe: (listener: (change: ConfigChanged) => void) => () => void;
};

function controlFor(
  descriptor: SettingsSectionDescriptor,
  key: string,
): SettingControl | undefined {
  return descriptor.controls.find((control) => control.key === key);
}

export async function readSection(
  client: ConfigStoreClient,
  descriptor: SettingsSectionDescriptor,
  folder: FolderPath | null,
): Promise<ConfigSnapshot> {
  const result = await client.list({ folder });
  const keys = new Set(descriptor.controls.map((control) => control.key));
  return Object.freeze({
    folder,
    revision: result.revision,
    entries: Object.freeze(result.entries.filter((entry) => keys.has(entry.key))),
  });
}

export function stage(
  descriptor: SettingsSectionDescriptor,
  state: StagedSettings,
  key: string,
  value: SettingValue,
): StageResult {
  const control = controlFor(descriptor, key);
  if (!control) {
    return {
      ok: false,
      validation: { valid: false, code: "unknown-key", message: `Unknown setting ${key}` },
    };
  }
  const validation = validate(control, value, state.snapshot);
  if (!validation.valid) return { ok: false, validation };
  return {
    ok: true,
    state: Object.freeze({
      snapshot: state.snapshot,
      edits: Object.freeze({ ...state.edits, [key]: value }),
    }),
  };
}

export function validate(
  control: SettingControl,
  value: SettingValue,
  snapshot: ConfigSnapshot,
): ValidationResult {
  if (control.secret !== value.secret) {
    return {
      valid: false,
      code: "secret-kind",
      message: "The control value kind does not match the setting.",
    };
  }
  try {
    const result = control.validate(value, snapshot);
    return result.valid ? result : { ...result, message: result.message || "Invalid value" };
  } catch {
    return { valid: false, code: "validator-error", message: "The value could not be validated." };
  }
}

export function preview(
  descriptor: SettingsSectionDescriptor,
  state: StagedSettings,
  key: string,
): PreviewResult {
  const control = controlFor(descriptor, key);
  const value = state.edits[key];
  if (!control || !value) {
    return {
      ok: false,
      validation: { valid: false, code: "unknown-key", message: `No staged value for ${key}` },
    };
  }
  const validation = validate(control, value, state.snapshot);
  if (!validation.valid) return { ok: false, validation };
  try {
    return { ok: true, patch: control.preview?.(value, state.snapshot) ?? null };
  } catch {
    return {
      ok: false,
      validation: {
        valid: false,
        code: "preview-error",
        message: "The preview could not be applied.",
      },
    };
  }
}

export function resetToEffective(state: StagedSettings, key: string): StagedSettings {
  if (!(key in state.edits)) return state;
  const edits = { ...state.edits };
  delete edits[key];
  return Object.freeze({ snapshot: state.snapshot, edits: Object.freeze(edits) });
}

export async function commit(
  client: ConfigStoreClient,
  descriptor: SettingsSectionDescriptor,
  state: StagedSettings,
  layer: ConfigWriteLayer,
): Promise<CommitResult> {
  let revision = state.snapshot.revision;
  const entries: ConfigEntry[] = [];
  let status: ApplyStatus = "applied";
  for (const control of descriptor.controls) {
    const value = state.edits[control.key];
    if (!value) continue;
    const validation = validate(control, value, state.snapshot);
    if (!validation.valid)
      throw new AppFailure({ code: "invalid_args", message: validation.message, retryable: false });
    const result = await client.write({
      key: control.key,
      layer,
      value: value as ConfigWriteValue,
      folder: state.snapshot.folder,
      expectedRevision: revision,
    });
    entries.push(result.entry);
    revision = result.revision;
    status = maxApplyStatus(status, control.apply);
  }
  return Object.freeze({ entries: Object.freeze(entries), revision, status });
}

export function subscribeChanged(
  source: ConfigChangeSource,
  descriptor: SettingsSectionDescriptor,
  listener: (change: ConfigChanged) => void,
): () => void {
  const keys = new Set(descriptor.controls.map((control) => control.key));
  return source.subscribe((change) => {
    if (keys.has(change.key)) listener(change);
  });
}

function maxApplyStatus(current: ApplyStatus, boundary: ApplyBoundary): ApplyStatus {
  const rank: Record<ApplyStatus, number> = {
    applied: 0,
    "session-only": 1,
    "reload-required": 2,
    "restart-required": 3,
    unsupported: 4,
  };
  const next: ApplyStatus =
    boundary === "live"
      ? "applied"
      : boundary === "session"
        ? "session-only"
        : boundary === "reload"
          ? "reload-required"
          : boundary === "restart"
            ? "restart-required"
            : "unsupported";
  return rank[next] > rank[current] ? next : current;
}

export function effectiveEntry(snapshot: ConfigSnapshot, key: string): ConfigEntry | undefined {
  return snapshot.entries.find((entry) => entry.key === key);
}

export function provenanceLabel(entry: ConfigEntry): string {
  const source = entry.source;
  const overrides = entry.overrides.length > 0 ? ` · overrides ${entry.overrides.join(", ")}` : "";
  return `${source}${overrides}`;
}

export function secretSummary(
  entry: ConfigEntry,
): { readonly isSecret: true; readonly isSet: boolean; readonly source: string } | null {
  return entry.secret ? { isSecret: true, isSet: entry.isSet, source: entry.source } : null;
}
