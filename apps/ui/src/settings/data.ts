/**
 * omp's settings, as its own settings page lists them, plus the few the app adds: `omp-settings.json`, generated from
 * the omp the server pins by `packages/server/scripts/omp-settings-ui.ts` (a server test fails while it is stale).
 */
export interface SettingDef {
  readonly key: string;
  /** omp's tab (`appearance`, `model`, …). */
  readonly tab: string;
  /** The section within the tab; `null` comes before the tab's first section. */
  readonly group: string | null;
  /** omp's type: boolean, string, number, enum, array or record. */
  readonly type: string;
  readonly label: string;
  readonly description: string;
  /** omp's default; absent when omp has none. */
  readonly default?: unknown;
  /** An enum's values. */
  readonly values?: readonly string[];
  /** The list omp's page picks from; a number's choices carry its value as text. */
  readonly choices?: readonly {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
  }[];
  /** The only entries a list takes. */
  readonly items?: readonly string[];
  readonly secret?: boolean;
  /** A list whose order matters. */
  readonly ordered?: boolean;
  /** Edited as JSON. */
  readonly json?: boolean;
  /** omp's named condition for showing it. */
  readonly condition?: string;
  /** omp's risk note. */
  readonly warning?: string;
  /** Only omp's terminal reads it (`omp-app tui` included); the app's chats do not. */
  readonly terminalOnly?: boolean;
}

export interface SettingsTab {
  readonly id: string;
  readonly label: string;
  /** omp's one-sentence lead under the tab's title. */
  readonly lead: string;
  /** The order of the tab's sections. */
  readonly groups: readonly string[];
}

export interface SettingsData {
  /** The omp release they were read from. */
  readonly omp: string;
  readonly tabs: readonly SettingsTab[];
  readonly settings: readonly SettingDef[];
}

let loading: Promise<SettingsData> | undefined;

/** omp's settings, read once, when the settings page first opens (the file stays out of the first load). */
export function loadSettingsData(): Promise<SettingsData> {
  loading ??= import("./omp-settings.json").then((module) => module.default as SettingsData);
  return loading;
}
