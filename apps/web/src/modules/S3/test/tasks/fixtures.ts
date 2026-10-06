import {
  AppFailure,
  type ConfigChanged,
  type ConfigEntry,
  ConfigWriteArgs,
  type ConfigWriteResult,
  type JsonValue,
  type Revision,
} from "@omp-app/contracts";
import type {
  ConfigChangeSource,
  ConfigStoreClient,
  SettingControlKind,
} from "../../../S1/settings-kit";

export interface TaskSettingEvidence {
  readonly key: string;
  readonly ompType: "boolean" | "enum" | "number" | "array" | "record" | "string";
  readonly controlKind: SettingControlKind | "map" | null;
  readonly defaultValue: JsonValue | undefined;
  readonly source: string;
}

export const TASK_SETTING_EVIDENCE = [
  {
    key: "todo.reminders",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/tools/settings.ts:359-362",
  },
  {
    key: "todo.remindersMax",
    ompType: "number",
    controlKind: "number",
    defaultValue: 3,
    source: "packages/coding-agent/src/tools/settings.ts:371-374",
  },
  {
    key: "todo.eager",
    ompType: "enum",
    controlKind: "enum",
    defaultValue: "default",
    source: "packages/coding-agent/src/tools/settings.ts:389-393",
  },
  {
    key: "tasks.todoClearDelay",
    ompType: "number",
    controlKind: "number",
    defaultValue: 60,
    source: "packages/coding-agent/src/tools/settings.ts:411-414",
  },
  {
    key: "skills.enableSkillCommands",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/extensibility/settings.ts:31-34",
  },
  {
    key: "commands.enableClaudeUser",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: false,
    source: "packages/coding-agent/src/extensibility/settings.ts:103-106",
  },
  {
    key: "commands.enableClaudeProject",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/extensibility/settings.ts:115-118",
  },
  {
    key: "commands.enableOpencodeUser",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: false,
    source: "packages/coding-agent/src/extensibility/settings.ts:127-130",
  },
  {
    key: "commands.enableOpencodeProject",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/extensibility/settings.ts:139-142",
  },
  {
    key: "task.isolation.enabled",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: false,
    source: "packages/coding-agent/src/task/settings.ts:23-27",
  },
  {
    key: "isolation.backend",
    ompType: "enum",
    controlKind: "enum",
    defaultValue: "auto",
    source: "packages/coding-agent/src/task/settings.ts:36-41",
  },
  {
    key: "worktree.clone",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/task/settings.ts:73-77",
  },
  {
    key: "worktree.cleanSource",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: false,
    source: "packages/coding-agent/src/task/settings.ts:87-91",
  },
  {
    key: "task.isolation.apply",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/task/settings.ts:101-105",
  },
  {
    key: "task.isolation.merge",
    ompType: "enum",
    controlKind: "enum",
    defaultValue: "patch",
    source: "packages/coding-agent/src/task/settings.ts:115-119",
  },
  {
    key: "task.isolation.commits",
    ompType: "enum",
    controlKind: "enum",
    defaultValue: "generic",
    source: "packages/coding-agent/src/task/settings.ts:133-137",
  },
  {
    key: "worktree.base",
    ompType: "string",
    controlKind: "path",
    defaultValue: undefined,
    source: "packages/coding-agent/src/task/settings.ts:151-154",
  },
  {
    key: "goal.enabled",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/goals/settings.ts:3-6",
  },
  {
    key: "goal.statusInFooter",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/goals/settings.ts:15-18",
  },
  {
    key: "goal.continuationModes",
    ompType: "array",
    controlKind: "list",
    defaultValue: ["interactive"],
    source: "packages/coding-agent/src/goals/settings.ts:27-32",
  },
  {
    key: "title.refreshOnReplan",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/goals/settings.ts:41-44",
  },
  {
    key: "plan.enabled",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/plan-mode/settings.ts:12-15",
  },
  {
    key: "plan.defaultOnStartup",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: false,
    source: "packages/coding-agent/src/plan-mode/settings.ts:24-27",
  },
  {
    key: "plan.autosave",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: false,
    source: "packages/coding-agent/src/plan-mode/settings.ts:37-40",
  },
  {
    key: "plan.autosaveDir",
    ompType: "string",
    controlKind: "path",
    defaultValue: undefined,
    source: "packages/coding-agent/src/plan-mode/settings.ts:50-53",
  },
  {
    key: "task.eager",
    ompType: "enum",
    controlKind: "enum",
    defaultValue: "default",
    source: "packages/coding-agent/src/task/settings.ts:172-177",
  },
  {
    key: "task.batch",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/task/settings.ts:195-199",
  },
  {
    key: "task.speculativeLaunch",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/task/settings.ts:209-212",
  },
  {
    key: "task.enableEffort",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: false,
    source: "packages/coding-agent/src/task/settings.ts:222-225",
  },
  {
    key: "task.maxConcurrency",
    ompType: "number",
    controlKind: "number",
    defaultValue: 32,
    source: "packages/coding-agent/src/task/settings.ts:235-239",
  },
  {
    key: "task.enableLsp",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: false,
    source: "packages/coding-agent/src/task/settings.ts:258-261",
  },
  {
    key: "task.maxRecursionDepth",
    ompType: "number",
    controlKind: "number",
    defaultValue: 2,
    source: "packages/coding-agent/src/task/settings.ts:271-275",
  },
  {
    key: "task.maxRuntimeMs",
    ompType: "number",
    controlKind: "duration",
    defaultValue: 0,
    source: "packages/coding-agent/src/task/settings.ts:291-294",
  },
  {
    key: "task.completionProbe",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/task/settings.ts:311-314",
  },
  {
    key: "task.agentIdleTtlMs",
    ompType: "number",
    controlKind: "duration",
    defaultValue: 420_000,
    source: "packages/coding-agent/src/task/settings.ts:324-327",
  },
  {
    key: "task.softRequestBudget",
    ompType: "number",
    controlKind: "number",
    defaultValue: 200,
    source: "packages/coding-agent/src/task/settings.ts:337-340",
  },
  {
    key: "task.softRequestBudgetNotice",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: true,
    source: "packages/coding-agent/src/task/settings.ts:356-359",
  },
  {
    key: "task.maxEffort",
    ompType: "enum",
    controlKind: "enum",
    defaultValue: "max",
    source: "packages/coding-agent/src/task/settings.ts:369-373",
  },
  {
    key: "task.disabledAgents",
    ompType: "array",
    controlKind: "list",
    defaultValue: [],
    source:
      "packages/coding-agent/src/task/settings.ts:384-388; docs/settings.md:104-106; docs/task-agent-discovery.md:211-213",
  },
  {
    key: "task.agentModelOverrides",
    ompType: "record",
    controlKind: "map",
    defaultValue: {},
    source:
      "packages/coding-agent/src/task/settings.ts:19-20,391-395; docs/settings.md:106; docs/task-agent-discovery.md:226-228",
  },
  {
    key: "task.agentServiceTierOverrides",
    ompType: "record",
    controlKind: "map",
    defaultValue: {},
    source:
      "packages/coding-agent/src/task/settings.ts:16,398-403; packages/coding-agent/src/config/service-tier.ts:67-82,90-106; docs/settings.md:106,517-518; docs/task-agent-discovery.md:247-251",
  },
  {
    key: "task.agentCompactionThresholdOverrides",
    ompType: "record",
    controlKind: "map",
    defaultValue: {},
    source:
      "packages/coding-agent/src/task/settings.ts:17,406-411; packages/coding-agent/src/config/compaction-threshold.ts:4-8,16-25; docs/settings.md:106,771; docs/task-agent-discovery.md:242-245",
  },
  {
    key: "task.agentPrewalk",
    ompType: "record",
    controlKind: "map",
    defaultValue: {},
    source:
      "packages/coding-agent/src/task/settings.ts:414-418; docs/settings.md:106; docs/task-agent-discovery.md:47,137",
  },
  {
    key: "task.agentAdvisor",
    ompType: "record",
    controlKind: "map",
    defaultValue: {},
    source:
      "packages/coding-agent/src/task/settings.ts:421-425; docs/settings.md:106,465; docs/task-agent-discovery.md:48,138",
  },
  {
    key: "task.prewalk",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: false,
    source: "packages/coding-agent/src/task/settings.ts:428-431",
  },
  {
    key: "task.showResolvedModelBadge",
    ompType: "boolean",
    controlKind: "boolean",
    defaultValue: false,
    source: "packages/coding-agent/src/task/settings.ts:441-452",
  },
] as const satisfies readonly TaskSettingEvidence[];

export interface TaskConfigStoreState {
  revision: Revision;
  entries: ConfigEntry[];
  listCalls: number;
  listFolders: (string | null)[];
  writeCalls: ConfigWriteArgs[];
}

export interface TaskConfigStoreFixture {
  readonly client: ConfigStoreClient;
  readonly state: TaskConfigStoreState;
}

export function defaultTaskConfigEntries(): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const setting of TASK_SETTING_EVIDENCE) {
    if (setting.defaultValue === undefined) continue;
    entries.push({
      key: setting.key,
      secret: false,
      value: setting.defaultValue,
      source: "default",
      overrides: [],
    });
  }
  return entries;
}

export function createTaskConfigStoreFixture(
  suppliedEntries: readonly ConfigEntry[] = defaultTaskConfigEntries(),
): TaskConfigStoreFixture {
  const entries: ConfigEntry[] = [];
  for (const entry of suppliedEntries) entries.push({ ...entry });
  const state: TaskConfigStoreState = {
    revision: "revision-1",
    entries,
    listCalls: 0,
    listFolders: [],
    writeCalls: [],
  };
  const client: ConfigStoreClient = {
    read: async (args) => {
      for (const entry of state.entries) {
        if (entry.key === args.key) return entry;
      }
      throw new AppFailure({
        code: "not_found",
        message: "The test value was not found.",
        retryable: false,
      });
    },
    list: async (args) => {
      state.listCalls += 1;
      state.listFolders.push(args.folder);
      const listed: ConfigEntry[] = [];
      for (const entry of state.entries) {
        if (args.prefix === undefined || entry.key.startsWith(args.prefix)) listed.push(entry);
      }
      return { entries: listed, revision: state.revision };
    },
    write: async (args): Promise<ConfigWriteResult> => {
      const writeCall = ConfigWriteArgs.parse(args);
      state.writeCalls.push(writeCall);
      const nextRevision = `revision-${state.writeCalls.length + 1}`;
      state.revision = nextRevision;
      const value = writeCall.value;
      let entry: ConfigEntry;
      if (value.secret) {
        entry = {
          key: writeCall.key,
          secret: true,
          isSet: value.action === "set",
          source: writeCall.layer,
          overrides: [],
        };
      } else {
        entry = {
          key: writeCall.key,
          secret: false,
          value: value.value,
          source: writeCall.layer,
          overrides: [],
        };
      }
      let index = -1;
      for (let position = 0; position < state.entries.length; position += 1) {
        if (state.entries[position]?.key === writeCall.key) index = position;
      }
      if (index < 0) state.entries.push(entry);
      else state.entries[index] = entry;
      return {
        key: writeCall.key,
        layer: writeCall.layer,
        folder: writeCall.folder,
        revision: nextRevision,
        previousRevision: writeCall.expectedRevision,
        entry,
      };
    },
  };
  return { client, state };
}

export interface TaskConfigChangesFixture {
  readonly source: ConfigChangeSource;
  emit(change: ConfigChanged): void;
}

export function createTaskConfigChangesFixture(): TaskConfigChangesFixture {
  const listeners = new Set<(change: ConfigChanged) => void>();
  const source: ConfigChangeSource = {
    subscribe(listener) {
      listeners.add(listener);
      return function unsubscribe() {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    emit(change) {
      for (const listener of listeners) listener(change);
    },
  };
}
