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

/** The variables that override settings a save just wrote: omp keeps using them until they are removed. */
export type EnvironmentOverride = { readonly variables: readonly string[] };

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

/**
 * How long a settings read may take before it fails with a message and a Retry. A read the server never
 * answers would otherwise keep its section on "Loading" with no error.
 */
export const SETTINGS_READ_TIMEOUT_MS = 15_000;

/** Races a read against SETTINGS_READ_TIMEOUT_MS, so a read the server never answers becomes an error. */
function withReadDeadline<T>(read: Promise<T>): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    deadline.reject(
      new AppFailure({
        code: "timeout",
        message: "Settings took too long to load.",
        retryable: true,
      }),
    );
  }, SETTINGS_READ_TIMEOUT_MS);
  return Promise.race([read, deadline.promise]).finally(() => clearTimeout(timer));
}

export async function readSection(
  client: ConfigStoreClient,
  descriptor: SettingsSectionDescriptor,
  folder: FolderPath | null,
): Promise<ConfigSnapshot> {
  const result = await withReadDeadline(client.list({ folder }));
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
 * The words after "Enter" that state a number's allowed range: "a whole number, 0 or more", or "a
 * number from 0 to 100". No maximum, or Number.MAX_VALUE, is no upper limit, so the words say "or more"
 * and never print that number (1.7976931348623157e+308). The S1, S2, S3 and I5 validators that state a range use this.
 */
export function numberRangeWords(integer: boolean, minimum: number, maximum?: number): string {
  const kind = integer ? "a whole number" : "a number";
  return maximum === undefined || maximum >= Number.MAX_VALUE
    ? `${kind}, ${minimum} or more`
    : `${kind} from ${minimum} to ${maximum}`;
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

/**
 * A value the server hides (a credential in its URL) reads as secret on a plain control, so its Replace and Clear
 * send a secret edit. A new address is checked as the plain control checks text, and a clear always passes.
 */
export function validate(
  control: SettingControl,
  value: SettingValue,
  snapshot: ConfigSnapshot,
): ValidationResult {
  if (control.secret === value.secret) return checkValue(control, value, snapshot);
  const hidden = snapshot.entries.some((entry) => entry.key === control.key && entry.secret);
  if (value.secret && !control.secret && hidden) {
    return value.action === "unset"
      ? { valid: true }
      : checkValue(control, { secret: false, value: value.value }, snapshot);
  }
  return {
    valid: false,
    code: "secret-kind",
    message: "The control value kind does not match the setting.",
  };
}

function checkValue(
  control: SettingControl,
  value: SettingValue,
  snapshot: ConfigSnapshot,
): ValidationResult {
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

/**
 * Writes the staged keys in control order, one CAS write per key, each carrying the revision the
 * previous write returned. Every value is validated before the first write, so an invalid value cannot
 * leave a section half saved. `onWritten` names each key omp accepted, so a caller whose later write
 * fails knows which keys did save.
 */
export async function commit(
  client: ConfigStoreClient,
  descriptor: SettingsSectionDescriptor,
  state: StagedSettings,
  layer: ConfigWriteLayer,
  onWritten: (key: string) => void = () => undefined,
): Promise<CommitResult> {
  const writes = descriptor.controls.flatMap((control) => {
    const value = state.edits[control.key];
    return value ? [{ control, value }] : [];
  });
  for (const { control, value } of writes) {
    const validation = validate(control, value, state.snapshot);
    if (!validation.valid)
      throw new AppFailure({ code: "invalid_args", message: validation.message, retryable: false });
  }
  let revision = state.snapshot.revision;
  const entries: ConfigEntry[] = [];
  let status: ApplyStatus = "applied";
  for (const { control, value } of writes) {
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
    onWritten(control.key);
  }
  return Object.freeze({ entries: Object.freeze(entries), revision, status });
}

/** The strongest apply boundary among `keys`: what a person must do before those changes take effect. */
export function applyStatusOf(
  descriptor: SettingsSectionDescriptor,
  keys: readonly string[],
): ApplyStatus {
  return descriptor.controls
    .filter((control) => keys.includes(control.key))
    .reduce<ApplyStatus>((status, control) => maxApplyStatus(status, control.apply), "applied");
}

/**
 * The environment override of the written settings: null when the environment supplies none of them. A written
 * setting omp reads from the environment counts even when its variable is not named, so the notice still shows.
 */
export function environmentOverrideOf(
  entries: readonly ConfigEntry[],
  keys: readonly string[],
): EnvironmentOverride | null {
  const overridden = entries.filter((entry) => keys.includes(entry.key) && entry.source === "env");
  if (overridden.length === 0) return null;
  const variables = new Set<string>();
  for (const entry of overridden) {
    if (entry.overriddenBy !== undefined) variables.add(entry.overriddenBy);
  }
  return { variables: [...variables] };
}

/** The plain sentence for a save that omp keeps overriding with the environment: the value is saved, and it is not in use. */
export function environmentOverrideText(override: EnvironmentOverride): string {
  const names = override.variables;
  if (names.length === 0) {
    return "Saved, but omp still uses the value from the environment until the variable is removed.";
  }
  const last = names.at(-1) ?? "";
  if (names.length === 1) {
    return `Saved, but omp still uses the environment variable ${last} until it is removed.`;
  }
  return `Saved, but omp still uses the environment variables ${names.slice(0, -1).join(", ")} and ${last} until they are removed.`;
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

/**
 * The edited keys whose stored value differs from the snapshot each edit was made against: the only
 * changes a person could be overwriting. A secret's value cannot be read back, so for a secret edit
 * any change to the file counts.
 */
export function changedEditKeys(staged: StagedSettings, remote: ConfigSnapshot): readonly string[] {
  return Object.keys(staged.edits).filter((key) => {
    const before = effectiveEntry(staged.snapshot, key);
    const now = effectiveEntry(remote, key);
    if (JSON.stringify(before) !== JSON.stringify(now)) return true;
    return (before?.secret ?? false) && remote.revision !== staged.snapshot.revision;
  });
}

/** The labels of the settings in `keys`, in the order the section shows them. */
export function settingLabels(
  descriptor: SettingsSectionDescriptor,
  keys: readonly string[],
): readonly string[] {
  return descriptor.controls
    .filter((control) => keys.includes(control.key))
    .map((control) => control.label);
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

/** The words for a setting's apply status: one set, used by every settings tab. */
export function applyStatusLabel(status: ApplyStatus): string {
  switch (status) {
    case "session-only":
      return "This session only";
    case "reload-required":
      return "Reload required";
    case "restart-required":
      return "Restart required";
    case "unsupported":
      return "Unavailable";
    default:
      return "Applied";
  }
}
/** Shared wording for an external settings conflict. */
export const SETTINGS_CONFLICT_HEADING = "Settings changed elsewhere";
export const SETTINGS_CONFLICT_DESCRIPTION =
  "Another change arrived while this section was open. Reload the latest values or keep your edits and save again.";

/** The two buttons of a settings conflict: one set, used by every settings tab. */
export const CONFLICT_BUTTON_LABELS = {
  reload: "Reload latest",
  keepMine: "Keep my edits",
} as const;
