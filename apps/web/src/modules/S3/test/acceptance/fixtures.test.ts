import type {
  ConfigChanged,
  ConfigEntry as ConfigEntryValue,
  ConfigWriteResult,
  JsonValue,
  Revision,
  SettingSource,
} from "@omp-app/contracts";
import {
  AppFailure,
  ConfigEntry,
  ConfigWriteArgs,
  checkScrubbed,
  overridesFollowPrecedence,
  SETTING_SOURCES,
} from "@omp-app/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { INVENTORY } from "../../../../../../../packages/contracts/src/core/inventory";
import { SettingsRuntime } from "../../../S1/runtime";
import type {
  ConfigChangeSource,
  ConfigSnapshot,
  ConfigStoreClient,
  SettingControl,
  SettingsSectionDescriptor,
} from "../../../S1/settings-kit";
import {
  S3_APPLY_OUTCOME_FIXTURES,
  S3_CONFIG_LIST_FIXTURE,
  S3_CONFLICT_FIXTURES,
  S3_INVALID_FIXTURES,
  S3_PROJECT_FOLDER,
  S3_PROVENANCE_FIXTURES,
  S3_SECRET_STATUS_FIXTURES,
  S3_SECTION_CONFIG_FIXTURES,
} from "../../fixtures";
import {
  OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT,
  S3_DEFAULT_EVIDENCE_GAPS,
} from "../../fixtures/omp-v18.8.9-defaults";
import {
  S3_SETTINGS_SECTIONS,
  TASKS_ISOLATION_SECTION,
  TASKS_MODES_SECTION,
  TASKS_SUBAGENTS_SECTION,
  TOOLS_TODOS_SECTION,
} from "../../sections";
import { readTasksPolicySnapshot, TaskSettingsSectionRuntime } from "../../tasks";
import type { TaskPolicyValue, TasksPolicySnapshot } from "../../tasks/policy";
import { TOOLS_SETTING_DEFAULTS, ToolsSettingsStore } from "../../tools";
import { TASK_SETTING_EVIDENCE } from "../tasks/fixtures";

type FakeConfig = {
  entries: ConfigEntryValue[];
  revision: Revision;
  writes: ConfigWriteArgs[];
  listeners: Set<(change: ConfigChanged) => void>;
  conflictNextWrite?: (typeof S3_CONFLICT_FIXTURES)[number] | undefined;
};

const liveStores: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const store of liveStores.splice(0)) store.dispose();
});

function configFor(
  entries: readonly ConfigEntryValue[] = S3_CONFIG_LIST_FIXTURE.entries,
): FakeConfig {
  const copy = [...entries];
  const resolvedBadge = TASK_SETTING_EVIDENCE.find(
    (item) => item.key === "task.showResolvedModelBadge",
  );
  if (!copy.some((entry) => entry.key === "task.showResolvedModelBadge")) {
    if (!resolvedBadge || resolvedBadge.defaultValue === undefined)
      throw new Error("Missing the S1-owned task policy default evidence.");
    copy.push(
      ConfigEntry.parse({
        key: resolvedBadge.key,
        secret: false,
        value: resolvedBadge.defaultValue,
        source: "default",
        overrides: [],
      }),
    );
  }
  return {
    entries: copy,
    revision: S3_CONFIG_LIST_FIXTURE.revision,
    writes: [],
    listeners: new Set(),
  };
}

function updateEntry(state: FakeConfig, entry: ConfigEntryValue): void {
  const index = state.entries.findIndex((candidate) => candidate.key === entry.key);
  if (index < 0) state.entries.push(entry);
  else state.entries[index] = entry;
}

function clientFor(state: FakeConfig): ConfigStoreClient {
  return {
    async read({ key }) {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry)
        throw new AppFailure({
          code: "not_found",
          message: "The setting was not found.",
          retryable: false,
        });
      return entry;
    },
    async list({ prefix }) {
      const entries =
        prefix === undefined
          ? state.entries
          : state.entries.filter((entry) => entry.key.startsWith(prefix));
      return { entries: [...entries], revision: state.revision };
    },
    async write(input): Promise<ConfigWriteResult> {
      const args = ConfigWriteArgs.parse(input);
      state.writes.push(args);
      const previousRevision = state.revision;
      const conflict = state.conflictNextWrite;
      if (conflict !== undefined && conflict.key === args.key) {
        state.conflictNextWrite = undefined;
        state.revision = conflict.remoteRevision;
        updateEntry(state, {
          key: conflict.key,
          secret: false,
          value: conflict.remoteValue,
          source: args.layer === "app" ? "project" : args.layer,
          overrides: args.layer === "project" ? ["global", "default"] : ["default"],
        });
        throw new AppFailure({
          code: "conflict",
          message: "Configuration changed elsewhere.",
          retryable: true,
        });
      }
      if (args.expectedRevision !== state.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Configuration changed elsewhere.",
          retryable: true,
        });
      }
      const revision = `s3-revision-${state.writes.length + 1}` as Revision;
      const overrides: ConfigEntryValue["overrides"] =
        args.layer === "project" ? ["global", "default"] : ["default"];
      const entry: ConfigEntryValue = args.value.secret
        ? {
            key: args.key,
            secret: true,
            isSet: args.value.action === "set",
            source: args.layer === "app" ? "project" : args.layer,
            overrides,
          }
        : {
            key: args.key,
            secret: false,
            value: args.value.value,
            source: args.layer === "app" ? "project" : args.layer,
            overrides,
          };
      state.revision = revision;
      updateEntry(state, entry);
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder,
        previousRevision,
        revision,
        entry,
      };
    },
  };
}

function changesFor(state: FakeConfig): ConfigChangeSource {
  return {
    subscribe(listener) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  };
}

function toolsStoreFor(state: FakeConfig): ToolsSettingsStore {
  const store = new ToolsSettingsStore(clientFor(state), changesFor(state), {
    folder: S3_PROJECT_FOLDER,
    layer: "project",
  });
  liveStores.push(store);
  return store;
}

function taskStoreFor(
  state: FakeConfig,
  section: SettingsSectionDescriptor,
): TaskSettingsSectionRuntime {
  const runtime = new SettingsRuntime(clientFor(state), changesFor(state), {
    descriptor: section,
    folder: S3_PROJECT_FOLDER,
    layer: "project",
  });
  const store = new TaskSettingsSectionRuntime(runtime);
  liveStores.push(store);
  return store;
}

function controlFor(section: SettingsSectionDescriptor, key: string): SettingControl {
  const control = section.controls.find((candidate) => candidate.key === key);
  if (!control) throw new Error(`Missing settings control ${key}.`);
  return control;
}

function entryFor(snapshot: ConfigSnapshot, key: string): ConfigEntryValue {
  const entry = snapshot.entries.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`Missing settings entry ${key}.`);
  return entry;
}

function sourceFor(entry: ConfigEntryValue): SettingSource {
  if (entry.source === "app") throw new Error(`Unexpected app-layer entry ${entry.key}.`);
  return entry.source;
}

function taskPolicyEntriesFor(
  source: SettingSource,
  overrides: readonly SettingSource[],
): ConfigEntryValue[] {
  const taskSectionIds = new Set([
    TOOLS_TODOS_SECTION.id,
    TASKS_ISOLATION_SECTION.id,
    TASKS_MODES_SECTION.id,
    TASKS_SUBAGENTS_SECTION.id,
  ]);
  const entries = S3_PROVENANCE_FIXTURES.filter(
    (fixture) => fixture.source === source && taskSectionIds.has(fixture.sectionId),
  ).flatMap((fixture) => fixture.snapshot.entries);
  const resolvedBadge = TASK_SETTING_EVIDENCE.find(
    (item) => item.key === "task.showResolvedModelBadge",
  );
  if (!resolvedBadge || resolvedBadge.defaultValue === undefined)
    throw new Error("Missing the S1-owned task policy evidence.");
  entries.push(
    ConfigEntry.parse({
      key: resolvedBadge.key,
      secret: false,
      value: resolvedBadge.defaultValue,
      source,
      overrides: [...overrides],
      ...(source === "default" ? {} : { provenance: { origin: "fixture", ompVersion: "18.6.1" } }),
    }),
  );
  return entries;
}

function provenanceEntriesFor(
  source: SettingSource,
  overrides: readonly SettingSource[],
): ConfigEntryValue[] {
  const entries = S3_PROVENANCE_FIXTURES.filter(
    (fixture) =>
      fixture.source === source && fixture.overrides.join("\u0000") === overrides.join("\u0000"),
  ).flatMap((fixture) => fixture.snapshot.entries);
  for (const entry of taskPolicyEntriesFor(source, overrides)) {
    if (!entries.some((candidate) => candidate.key === entry.key)) entries.push(entry);
  }
  return entries;
}

function emitExternalChange(
  state: FakeConfig,
  fixture: (typeof S3_CONFLICT_FIXTURES)[number],
): void {
  const entry: ConfigEntryValue = {
    key: fixture.key,
    secret: false,
    value: fixture.remoteValue,
    source: "project",
    overrides: ["global", "default"],
  };
  state.revision = fixture.remoteRevision;
  updateEntry(state, entry);
  const change: ConfigChanged = {
    key: fixture.key,
    layer: "project",
    folder: S3_PROJECT_FOLDER,
    revision: fixture.remoteRevision,
    entry,
  };
  for (const listener of state.listeners) listener(change);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function taskPolicyValues(snapshot: TasksPolicySnapshot): TaskPolicyValue<unknown>[] {
  return [
    snapshot.todos.reminders,
    snapshot.todos.remindersMax,
    snapshot.todos.eager,
    snapshot.todos.clearDelay,
    snapshot.subagents.eager,
    snapshot.subagents.batch,
    snapshot.subagents.speculativeLaunch,
    snapshot.subagents.enableEffort,
    snapshot.subagents.maxConcurrency,
    snapshot.subagents.enableLsp,
    snapshot.subagents.maxRecursionDepth,
    snapshot.subagents.maxRuntimeMs,
    snapshot.subagents.completionProbe,
    snapshot.subagents.agentIdleTtlMs,
    snapshot.subagents.softRequestBudget,
    snapshot.subagents.softRequestBudgetNotice,
    snapshot.subagents.maxEffort,
    snapshot.subagents.disabledAgents,
    snapshot.subagents.prewalk,
    snapshot.subagents.showResolvedModelBadge,
    snapshot.subagents.agentModelOverrides,
    snapshot.subagents.agentServiceTierOverrides,
    snapshot.subagents.agentCompactionThresholdOverrides,
    snapshot.subagents.agentPrewalk,
    snapshot.subagents.agentAdvisor,
  ];
}

function defaultValueFor(key: string): {
  readonly found: boolean;
  readonly value: JsonValue | undefined;
} {
  if (S3_DEFAULT_EVIDENCE_GAPS.some((gap) => gap === key))
    return { found: false, value: undefined };
  if (!Object.hasOwn(OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT, key))
    return { found: false, value: undefined };
  return {
    found: true,
    value: OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT[
      key as keyof typeof OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT
    ] as JsonValue | undefined,
  };
}

describe("S3.5 ConfigStore fixtures and gate proof", () => {
  test("matches S3-owned groups to inventory.json and every control to default evidence", () => {
    const expectedGroups = INVENTORY.filter(
      (item) =>
        item.group === "S5" &&
        ((item.name.startsWith("Tools /") && item.id !== "S5.tools-discovery-mcp") ||
          item.name.startsWith("Tasks /")),
    );
    const sectionIds = S3_SETTINGS_SECTIONS.flatMap((section) => section.inventory).sort();
    expect(sectionIds).toEqual(expectedGroups.map((item) => item.id).sort());
    expect(S3_SECTION_CONFIG_FIXTURES.map((fixture) => fixture.inventoryId).sort()).toEqual(
      sectionIds,
    );

    const actualKeys = S3_SETTINGS_SECTIONS.flatMap((section) =>
      section.controls.map((control) => control.key),
    ).sort();
    const taskKeys = TASK_SETTING_EVIDENCE.filter(
      (item) => !("ownedBy" in item) || item.ownedBy === undefined,
    ).map((item) => item.key);
    const expectedKeys = [...new Set([...Object.keys(TOOLS_SETTING_DEFAULTS), ...taskKeys])].sort();
    expect(actualKeys).toEqual(expectedKeys);

    const countDifferences = expectedGroups.flatMap((item) => {
      const match = /\((\d+)\)$/.exec(item.name);
      if (!match) throw new Error(`Inventory group ${item.id} has no control count.`);
      const section = S3_SETTINGS_SECTIONS.find((candidate) =>
        candidate.inventory.includes(item.id),
      );
      if (!section) throw new Error(`Missing settings section for ${item.id}.`);
      const declared = Number(match[1]);
      const actual = section.controls.length;
      return actual === declared ? [] : [{ id: item.id, declared, actual }];
    });
    expect(countDifferences.map((difference) => difference.id)).toEqual([
      "S5.tasks-isolation",
      "S5.tasks-subagents",
      "S5.tools-execution",
    ]);
    expect(countDifferences.every((difference) => difference.actual > difference.declared)).toBe(
      true,
    );
  });

  test("checks S3 evidence tables against the committed v18.8.9 registry-default extract", () => {
    const taskRows = TASK_SETTING_EVIDENCE.filter(
      (item) => !("ownedBy" in item) || item.ownedBy === undefined,
    ).map((item) => [item.key, item.defaultValue] as const);
    const tableRows = [
      ...Object.entries(TOOLS_SETTING_DEFAULTS),
      ...taskRows,
    ] as readonly (readonly [string, JsonValue | undefined])[];
    const tableKeys = [...new Set(tableRows.map(([key]) => key))].sort();
    expect(tableKeys).toEqual(Object.keys(OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT).sort());

    const mismatches = new Set<string>();
    for (const [key, tableValue] of tableRows) {
      const registryValue =
        OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT[
          key as keyof typeof OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT
        ];
      if (JSON.stringify(tableValue) !== JSON.stringify(registryValue)) mismatches.add(key);
    }
    expect([...mismatches].sort()).toEqual([...S3_DEFAULT_EVIDENCE_GAPS].sort());
    expect(OMP_V18_8_9_DEFAULT_REGISTRY_EXTRACT["computer.display"]).toBe("active");
  });

  test("uses every v18.8.9 registry default, including Computer Display", () => {
    const defaults = S3_PROVENANCE_FIXTURES.filter((fixture) => fixture.source === "default");
    expect(S3_DEFAULT_EVIDENCE_GAPS).toEqual([]);
    for (const fixture of defaults) {
      expect(fixture.valueKind).toBe("omp-default");
      const section = S3_SETTINGS_SECTIONS.find((candidate) => candidate.id === fixture.sectionId);
      if (!section) throw new Error(`Missing settings section ${fixture.sectionId}.`);
      for (const control of section.controls) {
        const evidence = defaultValueFor(control.key);
        const entry = fixture.snapshot.entries.find((candidate) => candidate.key === control.key);
        if (!evidence.found) {
          expect(S3_DEFAULT_EVIDENCE_GAPS).toContain(control.key);
          expect(entry).toBeUndefined();
          continue;
        }
        if (evidence.value === undefined) {
          expect(entry).toBeUndefined();
          continue;
        }
        if (entry === undefined || entry.secret)
          throw new Error(`Missing default value for ${control.key}.`);
        expect(entry.value).toEqual(evidence.value);
        expect(sourceFor(entry)).toBe("default");
        expect(entry.overrides).toEqual([]);
        expect(entry.provenance?.ompVersion).toBe("18.8.9");
        expect(
          control.validate({ secret: false, value: evidence.value }, fixture.snapshot),
        ).toEqual({
          valid: true,
        });
      }
    }
    expect(
      S3_PROVENANCE_FIXTURES.filter((fixture) => fixture.source !== "default").every(
        (fixture) => fixture.valueKind === "synthetic-layer-sample",
      ),
    ).toBe(true);
    expect(checkScrubbed(JSON.stringify(S3_PROVENANCE_FIXTURES))).toEqual([]);
    expect(checkScrubbed(JSON.stringify(S3_SECRET_STATUS_FIXTURES))).toEqual([]);
  });

  test("feeds each provenance source through ToolsSettingsStore and the Tasks policy handoff", async () => {
    const sources = new Set(S3_PROVENANCE_FIXTURES.map((fixture) => fixture.source));
    expect([...sources].sort()).toEqual([...SETTING_SOURCES].sort());
    for (const fixture of S3_PROVENANCE_FIXTURES) {
      for (const entry of fixture.snapshot.entries) {
        expect(sourceFor(entry)).toBe(fixture.source);
        expect(entry.overrides).toEqual(fixture.overrides);
        expect(overridesFollowPrecedence(sourceFor(entry), entry.overrides)).toBe(true);
      }
    }

    const sourceCases = new Map<
      string,
      { source: SettingSource; overrides: readonly SettingSource[] }
    >();
    for (const fixture of S3_PROVENANCE_FIXTURES) {
      sourceCases.set(`${fixture.source}:${fixture.overrides.join(",")}`, {
        source: fixture.source,
        overrides: fixture.overrides,
      });
    }
    for (const { source, overrides } of sourceCases.values()) {
      const state = configFor(provenanceEntriesFor(source, overrides));
      const tools = toolsStoreFor(state);
      await tools.read();
      const toolsSnapshot = tools.getSnapshot().config;
      if (!toolsSnapshot) throw new Error("ToolsSettingsStore returned no ConfigStore snapshot.");
      for (const entry of toolsSnapshot.entries) {
        expect(sourceFor(entry)).toBe(source);
        expect(entry.overrides).toEqual(overrides);
      }
      expect(tools.getSnapshot().policy?.provenance["grep.contextBefore"]).toMatchObject({
        source,
        overrides,
      });

      const tasks = await readTasksPolicySnapshot(clientFor(state), S3_PROJECT_FOLDER);
      for (const value of taskPolicyValues(tasks)) {
        if (value.source === "app")
          throw new Error(`Unexpected app-layer task policy ${value.key}.`);
        expect(value.source).toBe(source);
        expect(value.overrides).toEqual(overrides);
        expect(overridesFollowPrecedence(value.source, value.overrides)).toBe(true);
      }
    }
  });

  test("keeps the real Auto QA token status-only through ToolsSettingsStore", async () => {
    for (const fixture of S3_SECRET_STATUS_FIXTURES) {
      const state = configFor([...S3_CONFIG_LIST_FIXTURE.entries, ConfigEntry.parse(fixture)]);
      const tools = toolsStoreFor(state);
      await tools.read();
      const policy = tools.getSnapshot().policy;
      expect(policy?.developer.autoqaPushToken.isSet).toBe(fixture.isSet);
      expect(policy?.redacted).toContain("dev.autoqaPush.token");
      const entry = tools
        .getSnapshot()
        .config?.entries.find((candidate) => candidate.key === fixture.key);
      expect(entry?.secret).toBe(true);
      expect(entry && "value" in entry).toBe(false);
      expect(JSON.stringify(policy)).not.toContain("credential-value");
    }
  });

  test("asserts S3 descriptor validator codes and descriptor-owned range boundaries", () => {
    for (const fixture of S3_INVALID_FIXTURES) {
      const section = S3_SETTINGS_SECTIONS.find((candidate) =>
        candidate.controls.some((control) => control.key === fixture.key),
      );
      const sectionFixture = S3_SECTION_CONFIG_FIXTURES.find(
        (candidate) => candidate.sectionId === section?.id,
      );
      if (!section || !sectionFixture)
        throw new Error(`Missing invalid-fixture section for ${fixture.key}.`);
      expect(
        controlFor(section, fixture.key).validate(
          { secret: false, value: fixture.value },
          sectionFixture.snapshot,
        ),
      ).toMatchObject({
        valid: false,
        code: fixture.expectedCode,
      });
    }
    const grepSection = S3_SETTINGS_SECTIONS.find((section) =>
      section.inventory.includes("S5.tools-grep-browser"),
    );
    const grepSnapshot = S3_SECTION_CONFIG_FIXTURES.find(
      (fixture) => fixture.sectionId === grepSection?.id,
    )?.snapshot;
    if (!grepSection || !grepSnapshot) throw new Error("Missing Grep and Browser setting fixture.");
    const grep = controlFor(grepSection, "grep.contextBefore");
    expect(grep.validate({ secret: false, value: 0 }, grepSnapshot)).toEqual({ valid: true });
    expect(grep.validate({ secret: false, value: 100 }, grepSnapshot)).toEqual({ valid: true });
    expect(grep.validate({ secret: false, value: 101 }, grepSnapshot)).toMatchObject({
      valid: false,
      code: "range",
    });
  });

  test("projects typed Tools and Tasks policy handoffs for downstream consumers", async () => {
    const state = configFor();
    const tools = toolsStoreFor(state);
    await tools.read();
    const policy = tools.getSnapshot().policy;
    if (!policy) throw new Error("Tools policy was not projected.");
    expect(policy.availability.glob).toBe(false);
    expect(policy.grepBrowser.contextBefore).toBe(0);
    expect(policy.computer.maxWidth).toBe(1);
    expect(policy.github.cacheSoftTtlSec).toBe(0);
    expect(policy.outputLimits.artifactTailKb).toBe(0);
    expect(policy.execution.asyncEnabled).toBe(false);

    const tasks = await readTasksPolicySnapshot(clientFor(state), S3_PROJECT_FOLDER);
    expect(tasks.todos.reminders).toMatchObject({
      key: "todo.reminders",
      value: false,
      source: "project",
    });
    expect(tasks.subagents.batch).toMatchObject({
      key: "task.batch",
      value: false,
      source: "project",
    });
    expect(tasks.subagents.agentModelOverrides).toMatchObject({
      key: "task.agentModelOverrides",
      value: {},
      source: "project",
    });
  });

  test("keeps external changes and CAS conflicts visible in both Tools and Tasks stores", async () => {
    const toolsConflict = S3_CONFLICT_FIXTURES.find((fixture) => fixture.target === "tools");
    const taskConflict = S3_CONFLICT_FIXTURES.find((fixture) => fixture.target === "tasks");
    if (!toolsConflict || !taskConflict) throw new Error("Missing typed S3 conflict fixture.");

    const toolsState = configFor();
    toolsState.conflictNextWrite = toolsConflict;
    const tools = toolsStoreFor(toolsState);
    await tools.read();
    expect(
      tools.stage(toolsConflict.key as keyof typeof TOOLS_SETTING_DEFAULTS, {
        secret: false,
        value: toolsConflict.localValue,
      }).ok,
    ).toBe(true);
    await expect(tools.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(tools.getSnapshot()).toMatchObject({
      phase: "conflict",
      config: { revision: toolsConflict.remoteRevision },
    });
    expect(
      tools.getSnapshot().staged?.edits[toolsConflict.key as keyof typeof TOOLS_SETTING_DEFAULTS],
    ).toEqual({ secret: false, value: toolsConflict.localValue });

    const taskState = configFor();
    taskState.conflictNextWrite = taskConflict;
    const taskRuntime = taskStoreFor(taskState, TASKS_SUBAGENTS_SECTION);
    await taskRuntime.read();
    expect(
      taskRuntime.stage(taskConflict.key, { secret: false, value: taskConflict.localValue }).ok,
    ).toBe(true);
    await expect(taskRuntime.save()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(taskRuntime.getSnapshot().phase).toBe("conflict");
    expect(taskRuntime.getSnapshot().staged?.edits[taskConflict.key]).toEqual({
      secret: false,
      value: taskConflict.localValue,
    });

    const externalToolsState = configFor();
    const externalTools = toolsStoreFor(externalToolsState);
    await externalTools.read();
    emitExternalChange(externalToolsState, toolsConflict);
    await settle();
    expect(externalTools.getSnapshot()).toMatchObject({
      config: { revision: toolsConflict.remoteRevision },
      policy: { outputLimits: { artifactTailKb: toolsConflict.remoteValue } },
    });

    const externalTaskState = configFor();
    const externalTask = taskStoreFor(externalTaskState, TASKS_SUBAGENTS_SECTION);
    await externalTask.read();
    emitExternalChange(externalTaskState, taskConflict);
    await settle();
    const externalTaskConfig = externalTask.getSnapshot().config;
    if (!externalTaskConfig) throw new Error("Task runtime did not load its ConfigStore snapshot.");
    const externalTaskEntry = entryFor(externalTaskConfig, taskConflict.key);
    if (externalTaskEntry.secret)
      throw new Error("External task conflict returned a secret entry.");
    expect(externalTaskEntry.value).toBe(taskConflict.remoteValue);
  });

  test("surfaces missing host.config as a typed unavailable result", async () => {
    expect(S3_SETTINGS_SECTIONS.every((section) => section.requires.includes("host.config"))).toBe(
      true,
    );
    const unavailable = new AppFailure({
      code: "unavailable",
      message: "Configuration is unavailable.",
      retryable: false,
      capability: "host.config",
    });
    const denied: ConfigStoreClient = {
      read: async () => {
        throw unavailable;
      },
      list: async () => {
        throw unavailable;
      },
      write: async () => {
        throw unavailable;
      },
    };
    const deniedTools = new ToolsSettingsStore(denied, changesFor(configFor()), {
      folder: S3_PROJECT_FOLDER,
      layer: "project",
    });
    liveStores.push(deniedTools);
    await expect(deniedTools.read()).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "host.config" },
    });
    expect(deniedTools.getSnapshot()).toMatchObject({
      phase: "error",
      error: { code: "unavailable", capability: "host.config" },
    });
    await expect(readTasksPolicySnapshot(denied, S3_PROJECT_FOLDER)).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "host.config" },
    });
  });

  test("executes each apply outcome through the owning S3 store", async () => {
    for (const fixture of S3_APPLY_OUTCOME_FIXTURES) {
      const section = S3_SETTINGS_SECTIONS.find((candidate) => candidate.id === fixture.sectionId);
      if (!section) throw new Error(`Missing apply-outcome section ${fixture.sectionId}.`);
      expect(controlFor(section, fixture.key).apply).toBe(fixture.apply);
      const state = configFor();
      if (fixture.target === "tools") {
        const store = toolsStoreFor(state);
        await store.read();
        expect(
          store.stage(fixture.key as keyof typeof TOOLS_SETTING_DEFAULTS, {
            secret: false,
            value: fixture.value,
          }).ok,
        ).toBe(true);
        expect((await store.save()).status).toBe(fixture.expected);
      } else {
        const store = taskStoreFor(state, section);
        await store.read();
        expect(store.stage(fixture.key, { secret: false, value: fixture.value }).ok).toBe(true);
        const result = await store.save({ confirmIsolation: async () => true });
        expect(result.status).toBe("saved");
        if (result.status === "saved") expect(result.result.status).toBe(fixture.expected);
      }
    }
  });
});
