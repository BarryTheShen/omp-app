import type {
  ConfigEntry as ConfigEntryValue,
  ConfigListResult as ConfigListResultValue,
  JsonValue,
  Revision,
  SecretStatus,
  SettingSource,
} from "@omp-app/contracts";
import {
  ConfigEntry,
  ConfigListResult,
  FolderPath as FolderPathSchema,
  SecretStatus as SecretStatusSchema,
} from "@omp-app/contracts";
import { S1_SETTINGS_SECTIONS } from "../descriptors";
import type {
  ConfigSnapshot,
  SettingControl,
  SettingField,
  SettingsSectionDescriptor,
} from "../settings-kit";

export const S1_SURFACE_INVENTORY_ROWS = [
  "S1.settings",
  "S1.settings-selector",
  "S1.theme-selector",
  "S1.show-images-selector",
] as const;

export const S1_SETTING_INVENTORY_ROWS = [
  "S1.appearance-theme",
  "S1.appearance-composer",
  "S1.appearance-status-line",
  "S1.appearance-display",
  "S1.appearance-images",
  "S3.interaction-input",
  "S3.interaction-approvals",
  "S3.interaction-notifications",
  "S3.interaction-collab",
  "S3.interaction-magic-keywords",
  "S3.interaction-startup-updates",
  "S3.interaction-power",
  "S3.interaction-agent",
  "S3.interaction-git",
] as const;

export const S1_OWNED_INVENTORY_ROWS = [
  ...S1_SURFACE_INVENTORY_ROWS,
  ...S1_SETTING_INVENTORY_ROWS,
] as const;

export type S1FixtureCoverage = {
  readonly inventoryId: (typeof S1_OWNED_INVENTORY_ROWS)[number];
  readonly scenario: "descriptor" | "config-store";
  readonly proof: string;
};

function inventoryIdFor(section: SettingsSectionDescriptor): S1FixtureCoverage["inventoryId"] {
  const [inventoryId] = section.inventory;
  if (!inventoryId) throw new Error(`S1 setting section ${section.id} has no inventory claim.`);
  return inventoryId as S1FixtureCoverage["inventoryId"];
}

/** One explicit gate proof for every inventory row owned by S1.5. */
export const S1_FIXTURE_COVERAGE: readonly S1FixtureCoverage[] = [
  { inventoryId: "S1.settings", scenario: "descriptor", proof: "S1_DESCRIPTORS app-local command" },
  {
    inventoryId: "S1.settings-selector",
    scenario: "descriptor",
    proof: "S1_DESCRIPTORS selector dialog",
  },
  {
    inventoryId: "S1.theme-selector",
    scenario: "descriptor",
    proof: "S1_DESCRIPTORS theme dialog",
  },
  {
    inventoryId: "S1.show-images-selector",
    scenario: "descriptor",
    proof: "S1_DESCRIPTORS show-images dialog",
  },
  ...S1_SETTINGS_SECTIONS.map((section) => ({
    inventoryId: inventoryIdFor(section),
    scenario: "config-store" as const,
    proof: `${section.id} synthetic ConfigStore snapshot`,
  })),
];

const PROJECT_FOLDER_FIXTURE = FolderPathSchema.parse("/workspace/omp-project");
const PROJECT_REVISION_FIXTURE = "s1-project-config-1" as Revision;
const PROJECT_PROVENANCE = {
  origin: "omp-config",
  ompVersion: "18.6.1",
  path: "<WORKSPACE>/.omp/config.yml",
} as const;
const GLOBAL_PROVENANCE = {
  origin: "omp-config",
  ompVersion: "18.6.1",
  path: "<HOME>/.omp/agent/config.yml",
} as const;

function fieldFixtureValue(field: SettingField): JsonValue {
  switch (field.kind) {
    case "boolean":
      return false;
    case "enum":
      return field.options?.[0]?.value ?? "fixture";
    case "number":
      return field.positive ? 1 : 0;
    case "list":
      return [];
    case "text":
      return "fixture";
  }
}

function rowFixtureValue(control: Extract<SettingControl, { readonly kind: "rows" }>): JsonValue {
  return Object.fromEntries(
    Object.entries(control.fields).map(([key, field]) => [key, fieldFixtureValue(field)]),
  );
}

function fixtureCandidates(control: SettingControl): readonly JsonValue[] {
  switch (control.kind) {
    case "boolean":
      return [false];
    case "enum":
      return control.options?.map((option) => option.value) ?? [];
    case "number":
    case "duration":
      return [10, 5, 1, 0, 100, 0.5, 1_000];
    case "text":
    case "multiline":
    case "path":
      return [
        "fixture",
        "",
        "https://fixture.invalid",
        "wss://fixture.invalid",
        "<WORKSPACE>/fixture",
      ];
    case "list":
      return [[], ["fixture"], "fixture"];
    case "map":
      return [{}, { fixture: fieldFixtureValue(control.value) }];
    case "rows":
      return [[], [rowFixtureValue(control)]];
    case "secret":
      return [];
  }
}

function provenanceForSource(source: SettingSource) {
  if (source === "project") return PROJECT_PROVENANCE;
  if (source === "global") return GLOBAL_PROVENANCE;
  return { origin: "fixture", ompVersion: "18.6.1" } as const;
}

function sectionEntry(
  control: SettingControl,
  snapshot: ConfigSnapshot,
  source: SettingSource,
  overrides: readonly SettingSource[],
): ConfigEntryValue {
  if (control.secret) {
    return ConfigEntry.parse({
      key: control.key,
      secret: true,
      isSet: false,
      source,
      overrides: [...overrides],
      provenance: provenanceForSource(source),
    });
  }

  const value = fixtureCandidates(control).find(
    (candidate) => control.validate({ secret: false, value: candidate }, snapshot).valid,
  );
  if (value === undefined) {
    throw new Error(`No safe ConfigStore fixture value validates for ${control.key}.`);
  }
  return ConfigEntry.parse({
    key: control.key,
    secret: false,
    value,
    source,
    overrides: [...overrides],
    provenance: provenanceForSource(source),
  });
}

export type S1SectionConfigFixture = {
  readonly inventoryId: S1FixtureCoverage["inventoryId"];
  readonly sectionId: SettingsSectionDescriptor["id"];
  readonly snapshot: ConfigSnapshot;
};

function sectionSnapshot(
  descriptor: SettingsSectionDescriptor,
  source: SettingSource,
  overrides: readonly SettingSource[],
  revision: Revision,
): ConfigSnapshot {
  let snapshot: ConfigSnapshot = {
    folder: PROJECT_FOLDER_FIXTURE,
    revision,
    entries: [],
  };
  for (const control of descriptor.controls) {
    const entry = sectionEntry(control, snapshot, source, overrides);
    snapshot = { ...snapshot, entries: [...snapshot.entries, entry] };
  }
  return snapshot;
}

/** Complete, secret-safe synthetic ConfigStore reads for all fourteen S1-owned settings groups. */
export const S1_SECTION_CONFIG_FIXTURES: readonly S1SectionConfigFixture[] =
  S1_SETTINGS_SECTIONS.map((descriptor) => ({
    inventoryId: inventoryIdFor(descriptor),
    sectionId: descriptor.id,
    snapshot: sectionSnapshot(
      descriptor,
      "project",
      ["global", "default"],
      PROJECT_REVISION_FIXTURE,
    ),
  }));

/** A1 ConfigStore list response containing every S1-owned setting key exactly once. */
export const S1_CONFIG_LIST_FIXTURE: ConfigListResultValue = ConfigListResult.parse({
  entries: S1_SECTION_CONFIG_FIXTURES.flatMap((fixture) => fixture.snapshot.entries),
  revision: PROJECT_REVISION_FIXTURE,
});

const SOURCE_LAYER_CASES = [
  { source: "env", overrides: ["runtime", "overlay", "project", "global", "default"] },
  { source: "runtime", overrides: ["overlay", "project", "global", "default"] },
  { source: "overlay", overrides: ["project", "global", "default"] },
  { source: "project", overrides: ["global", "default"] },
  { source: "global", overrides: ["default"] },
  { source: "default", overrides: [] },
  { source: "global", overrides: ["env", "default"] },
] as const satisfies readonly {
  readonly source: SettingSource;
  readonly overrides: readonly SettingSource[];
}[];

/** One full ConfigStore section snapshot per provenance layer for every S1-owned settings group. */
export type S1ProvenanceSectionFixture = {
  readonly inventoryId: S1FixtureCoverage["inventoryId"];
  readonly sectionId: SettingsSectionDescriptor["id"];
  readonly source: SettingSource;
  readonly overrides: readonly SettingSource[];
  readonly snapshot: ConfigSnapshot;
};

export const S1_PROVENANCE_FIXTURES: readonly S1ProvenanceSectionFixture[] =
  S1_SETTINGS_SECTIONS.flatMap((descriptor) =>
    SOURCE_LAYER_CASES.map(({ source, overrides }) => ({
      inventoryId: inventoryIdFor(descriptor),
      sectionId: descriptor.id,
      source,
      overrides,
      snapshot: sectionSnapshot(descriptor, source, overrides, PROJECT_REVISION_FIXTURE),
    })),
  );

/** ConfigStore secrets are status-only: neither set nor unset fixtures can carry a raw value. */
export const S1_SECRET_STATUS_FIXTURES: readonly SecretStatus[] = [
  SecretStatusSchema.parse({
    key: "s1.fixture.secretProbe",
    secret: true,
    isSet: true,
    source: "project",
    overrides: ["global", "default"],
    provenance: PROJECT_PROVENANCE,
  }),
  SecretStatusSchema.parse({
    key: "s1.fixture.secretProbe",
    secret: true,
    isSet: false,
    source: "default",
    overrides: [],
  }),
];

export const S1_PROJECT_FOLDER = PROJECT_FOLDER_FIXTURE;
