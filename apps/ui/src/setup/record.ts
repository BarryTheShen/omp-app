import type { BrowserSetting, Change, SettingValue } from "./plan";

/**
 * What the setup changed, kept in this browser so **Undo setup** puts every value back: a browser setting to the value
 * it had, an omp setting to the value the person had set, or out of the settings file when it was omp's default.
 */
export interface SetupRecord {
  /** When the changes were made (ISO). */
  readonly at: string;
  readonly changes: readonly Change[];
}

const KEY = "omp-app.ui.setup";

/** How the changes are made: each setting's own setter in this browser, omp's settings file for every folder. */
export interface Setters {
  readonly browser: (setting: BrowserSetting, value: SettingValue) => void;
  /** `"unset"` takes the key out of the file, so omp's default applies again. */
  readonly omp: (key: string, value: SettingValue | "unset") => Promise<void>;
}

/**
 * Makes the approved changes, in order, and keeps what was made. One that fails stops the rest; what was made before it
 * is kept in the record (so Undo can put it back) and the failure is thrown.
 */
export async function applyChanges(
  changes: readonly Change[],
  set: Setters,
  now: Date = new Date(),
): Promise<SetupRecord> {
  const made: Change[] = [];
  try {
    for (const change of changes) {
      if (change.where === "browser") set.browser(change.setting, change.to);
      else await set.omp(change.key, change.to);
      made.push(change);
    }
  } finally {
    if (made.length > 0) keepRecord({ at: now.toISOString(), changes: made });
  }
  return { at: now.toISOString(), changes: made };
}

/** Puts back every value the last setup changed, last first, and forgets the record. */
export async function undoSetup(record: SetupRecord, set: Setters): Promise<void> {
  for (const change of [...record.changes].reverse()) {
    if (change.where === "browser") set.browser(change.setting, change.from);
    else await set.omp(change.key, change.theirs ? change.from : "unset");
  }
  forgetRecord();
}

export function keptRecord(): SetupRecord | null {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof kept !== "object" || kept === null) return null;
    const { at, changes } = kept as Partial<SetupRecord>;
    return typeof at === "string" && Array.isArray(changes) ? { at, changes } : null;
  } catch {
    return null;
  }
}

function keepRecord(record: SetupRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // No storage: the setup still applied; Undo is not offered.
  }
}

function forgetRecord(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}
