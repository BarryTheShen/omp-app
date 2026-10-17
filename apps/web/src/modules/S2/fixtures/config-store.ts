import type {
  ConfigEntry,
  ConfigSource,
  FolderPath,
  JsonValue,
  Revision,
} from "@omp-app/contracts";
import {
  type ConfigSnapshot,
  changedEditKeys,
  provenanceLabel,
  type SettingsSectionDescriptor,
  type StagedSettings,
  secretSummary,
  settingSourceLabel,
} from "../../S1/settings-kit";
import {
  FILES_EDITING_SECTION,
  FILES_LSP_SECTION,
  FILES_READ_SUMMARIES_SECTION,
  FILES_READING_SECTION,
  SHELL_BASH_SECTION,
  SHELL_EVAL_RUNTIMES_SECTION,
} from "../sections";
import { defaultFilesEntries, filesSnapshot } from "../test/files/fixtures";
import { OMP_DEFAULTS, sectionSnapshot } from "../test/ui/fixtures";

export type S2ConfigGroupFixture = {
  readonly name: string;
  readonly descriptor: SettingsSectionDescriptor;
  readonly snapshot: ConfigSnapshot;
};

const FILE_GROUPS = [
  { name: "Files / Editing", descriptor: FILES_EDITING_SECTION },
  { name: "Files / Reading", descriptor: FILES_READING_SECTION },
  { name: "Files / Read Summaries", descriptor: FILES_READ_SUMMARIES_SECTION },
] as const;

const S2_GROUPS = [
  ...FILE_GROUPS.map(({ name, descriptor }) => ({
    name,
    descriptor,
    snapshot: filesSnapshot(descriptor, defaultFilesEntries(descriptor)),
  })),
  {
    name: "Files / LSP",
    descriptor: FILES_LSP_SECTION,
    snapshot: sectionSnapshot(FILES_LSP_SECTION),
  },
  {
    name: "Shell / Bash",
    descriptor: SHELL_BASH_SECTION,
    snapshot: sectionSnapshot(SHELL_BASH_SECTION),
  },
  {
    name: "Shell / Eval & Runtimes",
    descriptor: SHELL_EVAL_RUNTIMES_SECTION,
    snapshot: sectionSnapshot(SHELL_EVAL_RUNTIMES_SECTION),
  },
] as const satisfies readonly S2ConfigGroupFixture[];

/** Scrubbed ConfigStore snapshots for all six S2 groups, sourced from the section descriptors. */
export const S2_CONFIG_GROUP_FIXTURES: readonly S2ConfigGroupFixture[] = S2_GROUPS;

/** Synthetic provenance variants: A1 has no non-test S2 caller for env/runtime/overlay layers yet. */
export const S2_PROVENANCE_FIXTURES: readonly ConfigEntry[] = [
  {
    key: "read.defaultLimit",
    secret: false,
    value: 100,
    source: "env",
    overrides: ["runtime", "project", "global", "default"],
  },
  {
    key: "read.renderMarkdown",
    secret: false,
    value: true,
    source: "runtime",
    overrides: ["project", "global", "default"],
  },
  {
    key: "lsp.lazy",
    secret: false,
    value: false,
    source: "overlay",
    overrides: ["project", "global", "default"],
  },
  {
    key: "bash.direnvLoadTimeoutMs",
    secret: false,
    value: 45_000,
    source: "project",
    overrides: ["global", "default"],
  },
  {
    key: "eval.py",
    secret: false,
    value: true,
    source: "global",
    overrides: ["default"],
  },
  {
    key: "python.kernelMode",
    secret: false,
    value: "session",
    source: "default",
    overrides: [],
  },
];

/**
 * A1 redaction fixtures. A1's key-name rule reports an `apiKey` key as secret: an unset one has source "global", a set one
 * the layer it is set in (here the global layer). `provider.apiKey` is the stand-in key S1's tests use; omp has no such
 * setting. Its own credential keys, such as `auth.broker.token` and `searxng.token`, are hidden the same way.
 */
export const S2_SECRET_FIXTURES: readonly ConfigEntry[] = [
  {
    key: "provider.apiKey",
    secret: true,
    isSet: true,
    source: "global",
    overrides: [],
  },
  {
    key: "provider.apiKey",
    secret: true,
    isSet: false,
    source: "global",
    overrides: [],
  },
];

export type S2ConflictFixture = {
  readonly local: StagedSettings;
  readonly remote: ConfigSnapshot;
  readonly changedKeys: readonly string[];
};

const conflictFolder = "/workspace/project" as FolderPath;
const conflictRevision = "s2-conflict-revision" as Revision;
const conflictRemote: ConfigSnapshot = {
  folder: conflictFolder,
  revision: conflictRevision,
  entries: [
    {
      key: "bash.direnvLoadTimeoutMs",
      secret: false,
      value: 60_000,
      source: "project",
      overrides: ["global", "default"],
    },
  ],
};
const conflictLocal: StagedSettings = {
  snapshot: {
    folder: conflictFolder,
    revision: "s2-local-revision" as Revision,
    entries: [
      {
        key: "bash.direnvLoadTimeoutMs",
        secret: false,
        value: 30_000,
        source: "project",
        overrides: ["global", "default"],
      },
    ],
  },
  edits: {
    "bash.direnvLoadTimeoutMs": { secret: false, value: 45_000 },
  },
};

/** A stale CAS conflict: the person's edit remains staged beside the remote effective value. */
export const S2_CONFLICT_FIXTURE: S2ConflictFixture = {
  local: conflictLocal,
  remote: conflictRemote,
  changedKeys: changedEditKeys(conflictLocal, conflictRemote),
};

export const S2_FIXTURE_HELPERS = {
  effectiveSource(entry: ConfigEntry): string {
    return settingSourceLabel(entry.source);
  },
  provenance(entry: ConfigEntry): string {
    return provenanceLabel(entry);
  },
  secret(
    entry: ConfigEntry,
  ): { readonly isSecret: true; readonly isSet: boolean; readonly source: string } | null {
    return secretSummary(entry);
  },
  json(value: JsonValue): string {
    return JSON.stringify(value);
  },
};

export const S2_CONFIG_SOURCES: readonly ConfigSource[] = [
  "env",
  "runtime",
  "overlay",
  "project",
  "global",
  "default",
];

export { OMP_DEFAULTS };
