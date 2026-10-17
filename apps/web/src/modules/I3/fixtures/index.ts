import {
  ConfigEntry,
  type ConfigEntry as ConfigEntryValue,
  ConfigListResult,
  type ConfigListResult as ConfigListResultValue,
  FolderPath as FolderPathSchema,
  SecretStatus,
  type SettingSource,
} from "@omp-app/contracts";
import type { ConfigSnapshot, SettingsSectionDescriptor } from "../../S1/settings-kit";
import { MEMORY_SETTINGS_SECTIONS } from "../settings/descriptors";

export {
  I3_MEMORY_COMMAND_RESULTS,
  I3_MEMORY_ENTRIES,
  I3_MEMORY_PAGE,
} from "./memory";
export { I3_RULES } from "./rules";

export const I3_MEMORY_INVENTORY_ROWS = [
  "C4.memory",
  "C4.memory-clear",
  "C4.memory-diagnose",
  "C4.memory-enqueue",
  "C4.memory-mm-delete",
  "C4.memory-mm-history",
  "C4.memory-mm-list",
  "C4.memory-mm-refresh",
  "C4.memory-mm-reload",
  "C4.memory-mm-seed",
  "C4.memory-mm-show",
  "C4.memory-rebuild",
  "C4.memory-reset",
  "C4.memory-stats",
  "C4.memory-view",
] as const;

export const I3_SETTINGS_INVENTORY_ROWS = [
  "S5.memory-auto-learn",
  "S5.memory-general",
  "S5.memory-hindsight",
  "S5.memory-mnemopi",
  "S5.memory-sharpshooter",
] as const;

export const I3_OWNED_INVENTORY_ROWS = [
  ...I3_MEMORY_INVENTORY_ROWS,
  ...I3_SETTINGS_INVENTORY_ROWS,
] as const;

const PROJECT_FOLDER_FIXTURE = FolderPathSchema.parse("/workspace/omp-project");
const PROJECT_PROVENANCE = {
  origin: "fixture" as const,
  ompVersion: "18.8.9",
  path: "<WORKSPACE>/.omp/config.yml",
};
const SOURCE_LAYERS = [
  { source: "project", overrides: ["global", "default"] },
  { source: "global", overrides: ["default"] },
  { source: "default", overrides: [] },
] as const satisfies readonly { source: SettingSource; overrides: readonly SettingSource[] }[];

function fixtureEntry(
  source: SettingSource,
  overrides: readonly SettingSource[],
  control: SettingsSectionDescriptor["controls"][number],
): ConfigEntryValue {
  if (control.secret) {
    return ConfigEntry.parse({
      key: control.key,
      secret: true,
      isSet: source !== "default",
      source,
      overrides: [...overrides],
      provenance: PROJECT_PROVENANCE,
    });
  }
  const value =
    control.kind === "boolean"
      ? false
      : control.kind === "enum"
        ? (control.options?.[0]?.value ?? "fixture")
        : "fixture";
  return ConfigEntry.parse({
    key: control.key,
    secret: false,
    value,
    source,
    overrides: [...overrides],
    provenance: PROJECT_PROVENANCE,
  });
}

function sectionSnapshot(
  section: SettingsSectionDescriptor,
  source: SettingSource,
  overrides: readonly SettingSource[],
): ConfigSnapshot {
  return {
    folder: PROJECT_FOLDER_FIXTURE,
    revision: `i3-${section.id}-${source}-revision`,
    entries: section.controls.map((control) => fixtureEntry(source, overrides, control)),
  };
}

/** Complete, secret-safe synthetic ConfigStore reads for every I3 memory settings group. */
export const I3_CONFIG_SNAPSHOTS = MEMORY_SETTINGS_SECTIONS.flatMap((section) =>
  SOURCE_LAYERS.map(({ source, overrides }) => ({
    inventoryId: section.inventory[0],
    sectionId: section.id,
    source,
    snapshot: sectionSnapshot(section, source, overrides),
  })),
);

/** A ConfigStore list response with all five settings sections represented. */
export const I3_CONFIG_LIST_FIXTURE: ConfigListResultValue = ConfigListResult.parse({
  entries: I3_CONFIG_SNAPSHOTS.filter(({ source }) => source === "project").flatMap(
    ({ snapshot }) => snapshot.entries,
  ),
  revision: "i3-config-list-revision",
});

/** Both secret states are status-only and contain no raw credential value. */
export const I3_SECRET_STATUS_FIXTURES = [
  SecretStatus.parse({
    key: "hindsight.apiToken",
    secret: true,
    isSet: true,
    source: "global",
    overrides: ["default"],
    provenance: PROJECT_PROVENANCE,
  }),
  SecretStatus.parse({
    key: "mnemopi.embeddingApiKey",
    secret: true,
    isSet: false,
    source: "default",
    overrides: [],
  }),
] as const;
