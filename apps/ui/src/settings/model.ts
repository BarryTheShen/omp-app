import type { ConfigEntry, ConfigWriteLayer } from "@omp-app/contracts";
import type { SettingDef, SettingsTab } from "./data";

/** The settings in force for the page's scope, by key, as the config store lists them. */
export type Entries = ReadonlyMap<string, ConfigEntry>;

/** A setting's value in force: what a settings file, a variable or omp's default gives it. A secret's is never sent. */
export function inForce(def: SettingDef, entries: Entries): unknown {
  const entry = entries.get(def.key);
  if (entry === undefined) return def.default;
  if (entry.secret) return undefined;
  return entry.value ?? def.default;
}

/** Set in the scope's own settings file (every folder's, or this folder's): the row's changed dot and its Reset. */
export function changedHere(entry: ConfigEntry | undefined, layer: ConfigWriteLayer): boolean {
  if (entry === undefined || entry.source !== layer) return false;
  return entry.secret ? entry.isSet : entry.value !== null;
}

type Read = (key: string) => unknown;

/** omp's named conditions for showing a setting (omp's `config/settings-ui.ts`), over the values in force. */
const CONDITIONS: Readonly<Record<string, (read: Read, entries: Entries) => boolean>> = {
  advisorEnabled: (read) => read("advisor.enabled") === true,
  vimModeEnabled: (read) => read("tui.vimMode") === true,
  hindsightActive: (read) => read("memory.backend") === "hindsight",
  mnemopiActive: (read) => read("memory.backend") === "mnemopi",
  autolearnActive: (read) => read("autolearn.enabled") === true,
  autoThinkingActive: (read) => read("defaultThinkingLevel") === "auto",
  usageAwareFallbackEnabled: (read) => read("retry.usageAwareFallback") === true,
  planModeEnabled: (read) => read("plan.enabled") === true,
  planAutosaveEnabled: (read) => read("plan.enabled") === true && read("plan.autosave") === true,
  // omp edits this list in the global file only: a folder's own list is not offered there.
  contextFilesExtraNotProject: (_read, entries) =>
    entries.get("contextFiles.extra")?.source !== "project",
};

/** Whether omp would show the setting now; a condition this copy does not know shows it. */
export function shown(def: SettingDef, read: Read, entries: Entries): boolean {
  if (def.condition === undefined) return true;
  const test = CONDITIONS[def.condition];
  return test === undefined || test(read, entries);
}

/** A value in words, as "Changed from default: …" says it. */
export function valueText(def: SettingDef, value: unknown): string {
  if (value === undefined || value === null || value === "") return "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  const choice = def.choices?.find((one) => one.value === String(value));
  return choice?.label ?? String(value);
}

/** Whether a setting answers a search (already trimmed and lower-cased): its label, its description or its key. */
export function matches(def: SettingDef, query: string): boolean {
  return `${def.label}\n${def.description}\n${def.key}`.toLowerCase().includes(query);
}

/** A tab's settings in its sections: the unsectioned first, then omp's order, then any section omp does not list. */
export function sections(
  tab: SettingsTab,
  defs: readonly SettingDef[],
): readonly { readonly group: string | null; readonly defs: readonly SettingDef[] }[] {
  const order = [null, ...tab.groups];
  for (const def of defs) if (!order.includes(def.group)) order.push(def.group);
  return order
    .map((group) => ({ group, defs: defs.filter((def) => def.group === group) }))
    .filter((section) => section.defs.length > 0);
}
