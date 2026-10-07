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

type SettingControlBase = {
  readonly key: ConfigKey;
  readonly label: string;
  readonly description?: string;
  readonly secret: boolean;
  readonly validate: (value: SettingValue, snapshot: ConfigSnapshot) => ValidationResult;
  readonly apply: ApplyBoundary;
  readonly preview?: (value: SettingValue, snapshot: ConfigSnapshot) => PreviewPatch | null;
  /** Shown but not editable in the app; `reason` says, in plain English, where to change it. */
  readonly readOnly?: { readonly reason: string };
};

/** A single value edited in one input. */
export type ScalarSettingControl = SettingControlBase & {
  readonly kind: SettingControlKind;
  readonly options?: readonly SettingOption[];
};

/** One typed field of a structured setting: a map's value, or a column of a rows setting. */
export type SettingField = {
  readonly label: string;
  readonly kind: "text" | "number" | "enum" | "boolean" | "list";
  /** Choices for `enum`. */
  readonly options?: readonly SettingOption[];
  readonly placeholder?: string;
  /** A `number` must be greater than zero. */
  readonly positive?: boolean;
  /** A `number` must be a whole number. */
  readonly integer?: boolean;
  /** A one-item list is stored as a string instead of an array. */
  readonly collapseSingle?: boolean;
};

/** A record of name → value pairs, edited as rows (e.g. provider name → request limit). */
export type MapSettingControl = SettingControlBase & {
  readonly kind: "map";
  readonly keyLabel: string;
  readonly keyPlaceholder?: string;
  readonly value: SettingField;
  /** The add button, e.g. "Add provider". */
  readonly addLabel: string;
  /** Shown when there are no rows, e.g. "No provider-specific limits". */
  readonly emptyLabel: string;
};

/** An ordered list of objects with fixed fields, edited as rows (e.g. bash approval rules). */
export type RowsSettingControl = SettingControlBase & {
  readonly kind: "rows";
  /** Object property name → field. Every field is required. */
  readonly fields: Readonly<Record<string, SettingField>>;
  /** The order matters to omp (first match wins), so rows can be moved. */
  readonly ordered: boolean;
  readonly addLabel: string;
  readonly emptyLabel: string;
};

export type SettingControl = ScalarSettingControl | MapSettingControl | RowsSettingControl;

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

/** A readable label for a raw setting value: "apply_patch" → "Apply patch", "per-call" → "Per call". */
export function optionLabel(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

/**
 * Choices for an enum control. Every module builds its options here so no raw value reaches the UI;
 * `labels` covers what `optionLabel` can't spell (acronyms, product names, "xhigh").
 */
export function settingOptions(
  values: readonly string[],
  labels: Readonly<Record<string, string>> = {},
): readonly SettingOption[] {
  return values.map((value) => ({ value, label: labels[value] ?? optionLabel(value) }));
}

/** Where a settings screen's changes are written, as a sentence for the screen header. */
export function saveLocationText(layer: ConfigWriteLayer): string {
  switch (layer) {
    case "global":
      return "Changes are saved to your global omp settings.";
    case "project":
      return "Changes are saved to this project's omp settings.";
    case "app":
      return "Changes are saved in this app only.";
  }
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
  if (control.readOnly) {
    return {
      ok: false,
      validation: { valid: false, code: "read-only", message: control.readOnly.reason },
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

const SOURCE_LABELS: Readonly<Record<ConfigEntry["source"], string>> = {
  env: "Set in the environment",
  runtime: "Set for this run",
  overlay: "Set in an additional config file",
  project: "Saved for this project",
  global: "Saved for all projects",
  default: "omp's default",
  app: "Saved in this app only",
};

const OVERRIDE_LABELS: Readonly<Record<ConfigEntry["source"], string>> = {
  env: "the environment",
  runtime: "this run",
  overlay: "an additional config file",
  project: "project settings",
  global: "settings for all projects",
  default: "omp's default",
  app: "this app",
};

export function settingSourceLabel(source: ConfigEntry["source"]): string {
  return SOURCE_LABELS[source];
}

export function provenanceLabel(entry: ConfigEntry): string {
  const source = settingSourceLabel(entry.source);
  const overrides =
    entry.overrides.length > 0
      ? ` · overrides ${entry.overrides.map((layer) => OVERRIDE_LABELS[layer]).join(", ")}`
      : "";
  return `${source}${overrides}`;
}

export function secretSummary(
  entry: ConfigEntry,
): { readonly isSecret: true; readonly isSet: boolean; readonly source: string } | null {
  return entry.secret ? { isSecret: true, isSet: entry.isSet, source: entry.source } : null;
}

/** The text in each input of one row of a structured control (a map row is `key` + `value`). */
export type StructuredDraftRow = Readonly<Record<string, string>>;

export type StructuredResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly validation: ValidationResult & { readonly valid: false } };

/** The input text that shows a field's stored value. */
function fieldDraft(field: SettingField, value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (field.kind === "boolean") return value === true ? "true" : "false";
  if (field.kind === "list") {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    const items: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") return "";
      items.push(item);
    }
    return items.join(", ");
  }
  return typeof value === "object" ? "" : String(value);
}

function withArticle(noun: string): string {
  return `${/^[aeiou]/iu.test(noun) ? "an" : "a"} ${noun}`;
}

function invalid(message: string): StructuredResult {
  return { ok: false, validation: { valid: false, code: "structured", message } };
}

/** Parses one field's input text, or says in plain English what is wrong with it. */
function parseField(
  field: SettingField,
  draft: string,
):
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly message: string } {
  const noun = field.label.toLowerCase();
  if (field.kind === "boolean") return { ok: true, value: draft === "true" };
  if (field.kind === "enum") {
    const option = field.options?.find((candidate) => String(candidate.value) === draft);
    return option
      ? { ok: true, value: option.value }
      : { ok: false, message: `Choose ${withArticle(noun)}.` };
  }
  if (field.kind === "number") {
    const value = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(value) || (field.positive && value <= 0)) {
      return {
        ok: false,
        message: field.positive ? `Enter a positive ${noun}.` : `Enter a number for ${noun}.`,
      };
    }
    if (field.integer && !Number.isInteger(value)) {
      return { ok: false, message: `Enter a whole number for ${noun}.` };
    }
    return { ok: true, value };
  }
  if (field.kind === "list") {
    const items: string[] = [];
    for (const item of draft.split(",")) {
      const value = item.trim();
      if (value.length > 0) items.push(value);
    }
    if (items.length === 0) return { ok: false, message: `Enter ${withArticle(noun)}.` };
    const first = items[0];
    if (field.collapseSingle && items.length === 1 && first !== undefined) {
      return { ok: true, value: first };
    }
    return { ok: true, value: items };
  }

  const text = draft.trim();
  return text.length > 0
    ? { ok: true, value: text }
    : { ok: false, message: `Enter ${withArticle(noun)}.` };
}

function isJsonObject(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rows a structured control shows for a stored value (map rows sorted by name). */
export function structuredDrafts(
  control: MapSettingControl | RowsSettingControl,
  value: JsonValue | undefined,
): readonly StructuredDraftRow[] {
  if (control.kind === "map") {
    if (!isJsonObject(value)) return [];
    return Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => ({ key, value: fieldDraft(control.value, item) }));
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(isJsonObject)
    .map((item) =>
      Object.fromEntries(
        Object.entries(control.fields).map(([name, field]) => [
          name,
          fieldDraft(field, item[name]),
        ]),
      ),
    );
}

/** A new, empty row: text, numbers and lists blank; an enum starts on its first choice, a switch off. */
export function emptyStructuredDraft(
  control: MapSettingControl | RowsSettingControl,
): StructuredDraftRow {
  const initial = (field: SettingField): string =>
    field.kind === "enum"
      ? String(field.options?.[0]?.value ?? "")
      : field.kind === "boolean"
        ? "false"
        : "";
  if (control.kind === "map") return { key: "", value: initial(control.value) };
  return Object.fromEntries(
    Object.entries(control.fields).map(([name, field]) => [name, initial(field)]),
  );
}

/** Typed inputs (text, number and list) are blank; enum and switch fields always hold a choice. */
function isBlankRow(fields: readonly [string, SettingField][], row: StructuredDraftRow): boolean {
  const typed = fields.filter(
    ([, field]) => field.kind === "text" || field.kind === "number" || field.kind === "list",
  );
  return typed.length > 0 && typed.every(([name]) => (row[name] ?? "").trim() === "");
}

/**
 * The setting value the rows describe, or the first problem with them (in row order). A row whose
 * typed inputs are all blank (one just added) is left out instead of reported.
 */
export function structuredValue(
  control: MapSettingControl | RowsSettingControl,
  rows: readonly StructuredDraftRow[],
): StructuredResult {
  if (control.kind === "map") {
    const keyNoun = control.keyLabel.toLowerCase();
    const columns: [string, SettingField][] = [
      ["key", { label: control.keyLabel, kind: "text" }],
      ["value", control.value],
    ];
    const value: Record<string, JsonValue> = {};
    for (const row of rows) {
      if (isBlankRow(columns, row)) continue;
      const key = (row.key ?? "").trim();
      if (key.length === 0) return invalid(`Enter ${withArticle(keyNoun)}.`);
      if (Object.hasOwn(value, key)) return invalid(`${control.keyLabel}s must be unique.`);
      const parsed = parseField(control.value, row.value ?? "");
      if (!parsed.ok) return invalid(parsed.message);
      value[key] = parsed.value;
    }
    return { ok: true, value };
  }
  const fields = Object.entries(control.fields);
  const items: JsonValue[] = [];
  for (const row of rows) {
    if (isBlankRow(fields, row)) continue;
    const item: Record<string, JsonValue> = {};
    for (const [name, field] of fields) {
      const parsed = parseField(field, row[name] ?? "");
      if (!parsed.ok) return invalid(parsed.message);
      item[name] = parsed.value;
    }
    items.push(item);
  }
  return { ok: true, value: items };
}
