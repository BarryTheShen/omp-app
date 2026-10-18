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
import type {
  ConfigSnapshot,
  SettingControl,
  SettingField,
  SettingsSectionDescriptor,
} from "../../S1/settings-kit";
import { S3_SETTINGS_SECTIONS } from "../sections";
import {
  OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT,
  S3_DEFAULT_EVIDENCE_GAPS,
} from "./omp-v18.8.9-defaults";

const PROJECT_FOLDER_FIXTURE = FolderPathSchema.parse("/workspace/omp-project");
const PROJECT_REVISION_FIXTURE = "s3-project-config-1" as Revision;
const PROJECT_PROVENANCE = {
  origin: "fixture",
  path: "<WORKSPACE>/.omp/config.yml",
} as const;
const GLOBAL_PROVENANCE = {
  origin: "fixture",
  path: "<HOME>/.omp/agent/config.yml",
} as const;

function inventoryIdFor(section: SettingsSectionDescriptor): string {
  const inventoryId = section.inventory[0];
  if (inventoryId === undefined)
    throw new Error(`S3 setting section ${section.id} has no inventory claim.`);
  return inventoryId;
}

type DefaultEvidence =
  | { readonly found: true; readonly value: JsonValue | undefined }
  | { readonly found: false };

function defaultEvidenceFor(key: string): DefaultEvidence {
  if (S3_DEFAULT_EVIDENCE_GAPS.some((gap) => gap === key)) return { found: false };
  if (!Object.hasOwn(OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT, key)) return { found: false };
  return {
    found: true,
    value: OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT[
      key as keyof typeof OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT
    ] as JsonValue | undefined,
  };
}

function fieldFixtureValue(field: SettingField): JsonValue {
  switch (field.kind) {
    case "boolean":
      return false;
    case "enum":
      return field.options?.[0]?.value ?? "fixture";
    case "number":
      return 1;
    case "list":
      return [];
    case "text":
      return "fixture";
  }
}

function syntheticCandidates(control: SettingControl): readonly JsonValue[] {
  if (control.kind === "map") return [{}, { fixture: fieldFixtureValue(control.value) }];
  if (control.kind === "boolean") return [false, true];
  if (control.kind === "enum") return control.options?.map((option) => option.value) ?? [];
  if (control.kind === "number" || control.kind === "duration") return [0, 1, 10, 100, 1_000, 0.5];
  if (control.kind === "list") return [[], ["fixture"]];
  if (control.kind === "path")
    return [
      control.key === "worktree.base" ? "/WORKSPACE/.omp/worktrees" : "<WORKSPACE>/fixture",
      "fixture",
    ];
  if (control.key.toLowerCase().includes("url") || control.key.includes("endpoint"))
    return ["https://fixture.invalid"];
  if (control.kind === "text" || control.kind === "multiline") return ["fixture", ""];
  return [];
}

function provenanceForSource(source: SettingSource) {
  if (source === "default") return { origin: "host-fallback", ompVersion: "18.8.9" } as const;
  if (source === "project") return PROJECT_PROVENANCE;
  if (source === "global") return GLOBAL_PROVENANCE;
  return { origin: "fixture" } as const;
}

function sectionEntry(
  control: SettingControl,
  snapshot: ConfigSnapshot,
  source: SettingSource,
  overrides: readonly SettingSource[],
): ConfigEntryValue | undefined {
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

  let value: JsonValue | undefined;
  if (source === "default") {
    const evidence = defaultEvidenceFor(control.key);
    if (!evidence.found) {
      if (S3_DEFAULT_EVIDENCE_GAPS.some((gap) => gap === control.key)) return undefined;
      throw new Error(`Missing omp default evidence for ${control.key}.`);
    }
    value = evidence.value;
    // An unset default is absent from ConfigStore; it is not a generated value.
    if (value === undefined) return undefined;
  } else {
    value = syntheticCandidates(control).find(
      (candidate) => control.validate({ secret: false, value: candidate }, snapshot).valid,
    );
    if (value === undefined)
      throw new Error(`No valid synthetic ConfigStore sample for ${control.key}.`);
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

export type S3SectionConfigFixture = {
  readonly inventoryId: string;
  readonly sectionId: SettingsSectionDescriptor["id"];
  readonly valueKind: "synthetic";
  readonly snapshot: ConfigSnapshot;
};

function sectionSnapshot(
  descriptor: SettingsSectionDescriptor,
  source: SettingSource,
  overrides: readonly SettingSource[],
  revision: Revision,
): ConfigSnapshot {
  let snapshot: ConfigSnapshot = { folder: PROJECT_FOLDER_FIXTURE, revision, entries: [] };
  for (const control of descriptor.controls) {
    const entry = sectionEntry(control, snapshot, source, overrides);
    if (entry !== undefined) snapshot = { ...snapshot, entries: [...snapshot.entries, entry] };
  }
  return snapshot;
}

export const S3_SECTION_CONFIG_FIXTURES: readonly S3SectionConfigFixture[] =
  S3_SETTINGS_SECTIONS.map((descriptor) => ({
    inventoryId: inventoryIdFor(descriptor),
    sectionId: descriptor.id,
    valueKind: "synthetic",
    snapshot: sectionSnapshot(
      descriptor,
      "project",
      ["global", "default"],
      PROJECT_REVISION_FIXTURE,
    ),
  }));

export const S3_CONFIG_LIST_FIXTURE: ConfigListResultValue = ConfigListResult.parse({
  entries: S3_SECTION_CONFIG_FIXTURES.flatMap((fixture) => fixture.snapshot.entries),
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

export type S3ProvenanceSectionFixture = {
  readonly inventoryId: string;
  readonly sectionId: SettingsSectionDescriptor["id"];
  readonly source: SettingSource;
  readonly overrides: readonly SettingSource[];
  readonly valueKind: "omp-default" | "synthetic-layer-sample";
  readonly snapshot: ConfigSnapshot;
};

/** Default-source entries use the value in the S3 evidence tables; other layers are explicitly synthetic samples. */
export const S3_PROVENANCE_FIXTURES: readonly S3ProvenanceSectionFixture[] =
  S3_SETTINGS_SECTIONS.flatMap((descriptor) =>
    SOURCE_LAYER_CASES.map(({ source, overrides }) => ({
      inventoryId: inventoryIdFor(descriptor),
      sectionId: descriptor.id,
      source,
      overrides,
      valueKind:
        source === "default" ? ("omp-default" as const) : ("synthetic-layer-sample" as const),
      snapshot: sectionSnapshot(descriptor, source, overrides, PROJECT_REVISION_FIXTURE),
    })),
  );

/** The Auto QA token is status-only ConfigStore data; neither fixture carries or echoes a value. */
export const S3_SECRET_STATUS_FIXTURES: readonly SecretStatus[] = [
  SecretStatusSchema.parse({
    key: "dev.autoqaPush.token",
    secret: true,
    isSet: true,
    source: "project",
    overrides: ["global", "default"],
    provenance: PROJECT_PROVENANCE,
  }),
  SecretStatusSchema.parse({
    key: "dev.autoqaPush.token",
    secret: true,
    isSet: false,
    source: "default",
    overrides: [],
    provenance: provenanceForSource("default"),
  }),
];

export type S3ConflictFixture = {
  readonly target: "tools" | "tasks";
  readonly sectionId: SettingsSectionDescriptor["id"];
  readonly localRevision: Revision;
  readonly remoteRevision: Revision;
  readonly key: string;
  readonly localValue: JsonValue;
  readonly remoteValue: JsonValue;
};

export const S3_CONFLICT_FIXTURES: readonly S3ConflictFixture[] = [
  {
    target: "tools",
    sectionId: "S3.toolsOutputLimits",
    localRevision: PROJECT_REVISION_FIXTURE,
    remoteRevision: "s3-tools-remote-revision" as Revision,
    key: "tools.artifactTailBytes",
    localValue: 0,
    remoteValue: 1_024,
  },
  {
    target: "tasks",
    sectionId: "S3.tasksSubagents",
    localRevision: PROJECT_REVISION_FIXTURE,
    remoteRevision: "s3-tasks-remote-revision" as Revision,
    key: "task.maxConcurrency",
    localValue: 16,
    remoteValue: 64,
  },
];

export type S3InvalidFixture = {
  readonly key: string;
  readonly value: JsonValue;
  readonly expectedCode: "range" | "url" | "enum";
};

export const S3_INVALID_FIXTURES: readonly S3InvalidFixture[] = [
  { key: "grep.contextBefore", value: -1, expectedCode: "range" },
  { key: "browser.cdpUrl", value: "not-a-url", expectedCode: "url" },
  { key: "tools.artifactTailBytes", value: 1.5, expectedCode: "range" },
  { key: "isolation.backend", value: "invalid-backend", expectedCode: "enum" },
];

export type S3ApplyOutcomeFixture = {
  readonly target: "tools" | "tasks";
  readonly sectionId: SettingsSectionDescriptor["id"];
  readonly key: string;
  readonly value: JsonValue;
  readonly apply: SettingControl["apply"];
  readonly expected: "applied" | "session-only" | "reload-required" | "restart-required";
};

export const S3_APPLY_OUTCOME_FIXTURES: readonly S3ApplyOutcomeFixture[] = [
  {
    target: "tools",
    sectionId: "S3.toolsAvailable",
    key: "glob.enabled",
    value: false,
    apply: "live",
    expected: "applied",
  },
  {
    target: "tasks",
    sectionId: "S3.tasksModes",
    key: "goal.enabled",
    value: false,
    apply: "session",
    expected: "session-only",
  },
  {
    target: "tasks",
    sectionId: "S3.tasksModes",
    key: "plan.autosave",
    value: true,
    apply: "live",
    expected: "applied",
  },
  {
    target: "tasks",
    sectionId: "S3.tasksIsolation",
    key: "task.isolation.enabled",
    value: true,
    apply: "live",
    expected: "applied",
  },
];

export const S3_PROJECT_FOLDER = PROJECT_FOLDER_FIXTURE;
