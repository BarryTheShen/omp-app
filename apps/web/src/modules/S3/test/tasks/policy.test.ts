import type { ConfigEntry, ConfigListResult, Revision } from "@omp-app/contracts";
import { FolderPath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ConfigStoreClient } from "../../../S1/settings-kit";
import { createTasksPolicyStore, readTasksPolicySnapshot } from "../../tasks";
import {
  createTaskConfigChangesFixture,
  createTaskConfigStoreFixture,
  TASK_SETTING_EVIDENCE,
} from "./fixtures";

function settingIndex(entries: readonly ConfigEntry[], key: string): number {
  for (let position = 0; position < entries.length; position += 1) {
    if (entries[position]?.key === key) return position;
  }
  return -1;
}

describe("S3 typed ConfigStore handoffs", () => {
  test("reads todo and subagent policy from one revision with exact v18.6.1 defaults", async () => {
    const fixture = createTaskConfigStoreFixture();
    const snapshot = await readTasksPolicySnapshot(fixture.client, null);
    expect(fixture.state.listCalls).toBe(1);
    expect(fixture.state.listFolders).toEqual([null]);
    expect(snapshot.revision).toBe("revision-1");
    expect(snapshot.todos).toMatchObject({
      folder: null,
      revision: "revision-1",
      reminders: { key: "todo.reminders", value: true, source: "default", overrides: [] },
      remindersMax: { key: "todo.remindersMax", value: 3, source: "default", overrides: [] },
      eager: { key: "todo.eager", value: "default", source: "default", overrides: [] },
      clearDelay: { key: "tasks.todoClearDelay", value: 60, source: "default", overrides: [] },
    });
    expect(snapshot.subagents).toMatchObject({
      folder: null,
      revision: "revision-1",
      eager: { key: "task.eager", value: "default", source: "default", overrides: [] },
      batch: { key: "task.batch", value: true, source: "default", overrides: [] },
      speculativeLaunch: {
        key: "task.speculativeLaunch",
        value: true,
        source: "default",
        overrides: [],
      },
      enableEffort: { key: "task.enableEffort", value: false, source: "default", overrides: [] },
      maxConcurrency: { key: "task.maxConcurrency", value: 32, source: "default", overrides: [] },
      enableLsp: { key: "task.enableLsp", value: false, source: "default", overrides: [] },
      maxRecursionDepth: {
        key: "task.maxRecursionDepth",
        value: 2,
        source: "default",
        overrides: [],
      },
      maxRuntimeMs: { key: "task.maxRuntimeMs", value: 0, source: "default", overrides: [] },
      completionProbe: {
        key: "task.completionProbe",
        value: true,
        source: "default",
        overrides: [],
      },
      agentIdleTtlMs: {
        key: "task.agentIdleTtlMs",
        value: 420_000,
        source: "default",
        overrides: [],
      },
      softRequestBudget: {
        key: "task.softRequestBudget",
        value: 200,
        source: "default",
        overrides: [],
      },
      softRequestBudgetNotice: {
        key: "task.softRequestBudgetNotice",
        value: true,
        source: "default",
        overrides: [],
      },
      maxEffort: { key: "task.maxEffort", value: "max", source: "default", overrides: [] },
      disabledAgents: { key: "task.disabledAgents", value: [], source: "default", overrides: [] },
      prewalk: { key: "task.prewalk", value: false, source: "default", overrides: [] },
      showResolvedModelBadge: {
        key: "task.showResolvedModelBadge",
        value: false,
        source: "default",
        overrides: [],
      },
      agentModelOverrides: {
        key: "task.agentModelOverrides",
        value: {},
        source: "default",
        overrides: [],
      },
      agentServiceTierOverrides: {
        key: "task.agentServiceTierOverrides",
        value: {},
        source: "default",
        overrides: [],
      },
      agentCompactionThresholdOverrides: {
        key: "task.agentCompactionThresholdOverrides",
        value: {},
        source: "default",
        overrides: [],
      },
      agentPrewalk: { key: "task.agentPrewalk", value: {}, source: "default", overrides: [] },
      agentAdvisor: { key: "task.agentAdvisor", value: {}, source: "default", overrides: [] },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.todos)).toBe(true);
    expect(Object.isFrozen(snapshot.subagents.agentModelOverrides.value)).toBe(true);
    expect(Object.isFrozen(snapshot.subagents.disabledAgents.value)).toBe(true);
  });
  test("reads structured independently from batch when both are explicitly set", async () => {
    const fixture = createTaskConfigStoreFixture();
    for (const [key, value] of [
      ["task.structured", true],
      ["task.batch", false],
    ] as const) {
      const index = settingIndex(fixture.state.entries, key);
      const entry = fixture.state.entries[index];
      if (!entry || entry.secret) throw new Error(`Missing non-secret ${key} fixture.`);
      fixture.state.entries[index] = { ...entry, value };
    }
    const snapshot = await readTasksPolicySnapshot(fixture.client, null);
    expect(snapshot.subagents.structured.value).toBe(true);
    expect(snapshot.subagents.batch.value).toBe(false);
  });

  test("preserves project source, overridden layers, revision and typed map entries", async () => {
    const fixture = createTaskConfigStoreFixture();
    const modelEntryIndex = settingIndex(fixture.state.entries, "task.agentModelOverrides");
    const tierEntryIndex = settingIndex(fixture.state.entries, "task.agentServiceTierOverrides");
    const thresholdEntryIndex = settingIndex(
      fixture.state.entries,
      "task.agentCompactionThresholdOverrides",
    );
    const modelEntry = fixture.state.entries[modelEntryIndex];
    const tierEntry = fixture.state.entries[tierEntryIndex];
    const thresholdEntry = fixture.state.entries[thresholdEntryIndex];
    if (
      !modelEntry ||
      modelEntry.secret ||
      !tierEntry ||
      tierEntry.secret ||
      !thresholdEntry ||
      thresholdEntry.secret
    ) {
      throw new Error("Default map settings were not listed.");
    }
    fixture.state.entries[modelEntryIndex] = {
      ...modelEntry,
      value: { task: ["@slow", "provider/model"], scout: "provider/fast" },
      source: "project",
      overrides: ["global", "default"],
      provenance: {
        origin: "omp-config",
        ompVersion: "18.6.1",
        path: "<WORKSPACE>/.omp/config.yml",
      },
    };
    fixture.state.entries[tierEntryIndex] = {
      ...tierEntry,
      value: { task: "inherit", reviewer: "priority" },
      source: "global",
      overrides: ["default"],
    };
    fixture.state.entries[thresholdEntryIndex] = {
      ...thresholdEntry,
      value: { task: 90_000, scout: "80.5%", reviewer: null },
      source: "project",
      overrides: ["global", "default"],
    };
    const folder = FolderPath.parse("/workspace/project");
    const snapshot = await readTasksPolicySnapshot(fixture.client, folder);
    expect(fixture.state.listFolders).toEqual([folder]);
    expect(snapshot.subagents.agentModelOverrides).toMatchObject({
      key: "task.agentModelOverrides",
      value: { task: ["@slow", "provider/model"], scout: "provider/fast" },
      source: "project",
      overrides: ["global", "default"],
      provenance: {
        origin: "omp-config",
        ompVersion: "18.6.1",
        path: "<WORKSPACE>/.omp/config.yml",
      },
    });
    expect(snapshot.subagents.agentServiceTierOverrides).toMatchObject({
      value: { task: "inherit", reviewer: "priority" },
      source: "global",
      overrides: ["default"],
    });
    expect(snapshot.subagents.agentCompactionThresholdOverrides).toMatchObject({
      value: { task: 90_000, scout: "80.5%", reviewer: null },
      source: "project",
      overrides: ["global", "default"],
    });
    expect(snapshot.revision).toBe("revision-1");
  });

  test("uses defaults independently when entries are missing, secret, or malformed", async () => {
    const missing = createTaskConfigStoreFixture();
    const retainedEntries: ConfigEntry[] = [];
    for (const entry of missing.state.entries) {
      if (entry.key !== "task.agentAdvisor") retainedEntries.push(entry);
    }
    missing.state.entries = retainedEntries;
    const missingSnapshot = await readTasksPolicySnapshot(missing.client, null);
    expect(missingSnapshot.subagents.agentAdvisor).toMatchObject({
      key: "task.agentAdvisor",
      value: {},
      source: "default",
      overrides: [],
    });
    expect(missingSnapshot.todos.reminders.value).toBe(true);

    const malformedTier = createTaskConfigStoreFixture();
    const tierIndex = settingIndex(malformedTier.state.entries, "task.agentServiceTierOverrides");
    const tierEntry = malformedTier.state.entries[tierIndex];
    if (!tierEntry || tierEntry.secret)
      throw new Error("Default service-tier setting was not listed.");
    malformedTier.state.entries[tierIndex] = { ...tierEntry, value: { task: "fast" } };
    const malformedSnapshot = await readTasksPolicySnapshot(malformedTier.client, null);
    expect(malformedSnapshot.subagents.agentServiceTierOverrides).toMatchObject({
      value: {},
      source: "default",
    });
    expect(malformedSnapshot.subagents.maxConcurrency.value).toBe(32);

    const secret = createTaskConfigStoreFixture();
    const badgeIndex = settingIndex(secret.state.entries, "task.showResolvedModelBadge");
    if (badgeIndex < 0) throw new Error("Default badge setting was not listed.");
    secret.state.entries[badgeIndex] = {
      key: "task.showResolvedModelBadge",
      secret: true,
      isSet: true,
      source: "global",
      overrides: [],
    };
    const secretSnapshot = await readTasksPolicySnapshot(secret.client, null);
    expect(secretSnapshot.subagents.showResolvedModelBadge).toMatchObject({
      key: "task.showResolvedModelBadge",
      value: false,
      source: "default",
    });
  });

  test("matches every typed policy default when ConfigStore lists no entries", async () => {
    const fixture = createTaskConfigStoreFixture([]);
    const snapshot = await readTasksPolicySnapshot(fixture.client, null);
    const values = [
      snapshot.todos.reminders,
      snapshot.todos.remindersMax,
      snapshot.todos.eager,
      snapshot.todos.clearDelay,
      snapshot.subagents.eager,
      snapshot.subagents.batch,
      snapshot.subagents.speculativeLaunch,
      snapshot.subagents.structured,
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
    for (const policy of values) {
      const evidence = TASK_SETTING_EVIDENCE.find((item) => item.key === policy.key);
      expect(evidence, policy.key).toBeDefined();
      expect(policy.value, policy.key).toEqual(evidence?.defaultValue);
      expect(policy.source, policy.key).toBe("default");
    }
  });

  test("refreshes the typed policy through the ConfigStore change source", async () => {
    const fixture = createTaskConfigStoreFixture();
    const changes = createTaskConfigChangesFixture();
    const store = createTasksPolicyStore(fixture.client, changes.source, null);
    const first = await store.read();
    expect(first.todos.reminders.value).toBe(true);
    const reminders = fixture.state.entries.find((entry) => entry.key === "todo.reminders");
    if (!reminders || reminders.secret) throw new Error("Default reminders entry was not listed.");
    fixture.state.revision = "revision-2";
    fixture.state.entries[fixture.state.entries.indexOf(reminders)] = {
      ...reminders,
      value: false,
    };
    const refreshed = Promise.withResolvers<boolean>();
    const unsubscribe = store.subscribe((snapshot) => {
      if (snapshot.revision === "revision-2") refreshed.resolve(snapshot.todos.reminders.value);
    });
    changes.emit({
      key: reminders.key,
      layer: "global",
      folder: null,
      revision: "revision-2",
      entry: { ...reminders, value: false },
    });
    await expect(refreshed.promise).resolves.toBe(false);
    unsubscribe();
    store.dispose();
  });

  test("replays the current snapshot to late subscribers and disposes its change stream", async () => {
    const fixture = createTaskConfigStoreFixture();
    const changes = createTaskConfigChangesFixture();
    const store = createTasksPolicyStore(fixture.client, changes.source, null);
    const snapshot = await store.read();
    expect(changes.subscriberCount()).toBe(1);
    let delivered: unknown;
    const unsubscribe = store.subscribe((next) => {
      delivered = next;
    });
    expect(delivered).toBe(snapshot);
    unsubscribe();
    expect(changes.subscriberCount()).toBe(1);
    store.dispose();
    expect(changes.subscriberCount()).toBe(0);
    const reads = fixture.state.listCalls;
    const reminderEntry = fixture.state.entries.find((entry) => entry.key === "todo.reminders");
    if (!reminderEntry) throw new Error("Default reminders entry was not listed.");
    changes.emit({
      key: "todo.reminders",
      layer: "global",
      folder: null,
      revision: "revision-2",
      entry: reminderEntry,
    });
    await Promise.resolve();
    expect(fixture.state.listCalls).toBe(reads);
    await expect(store.read()).rejects.toMatchObject({ appError: { code: "cancelled" } });
  });

  test("drops an older read that finishes after a newer policy refresh", async () => {
    const fixture = createTaskConfigStoreFixture([]);
    const first = Promise.withResolvers<ConfigListResult>();
    const second = Promise.withResolvers<ConfigListResult>();
    let calls = 0;
    const client: ConfigStoreClient = {
      ...fixture.client,
      list: async () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    };
    const store = createTasksPolicyStore(client, createTaskConfigChangesFixture().source, null);
    const older = store.read();
    await Promise.resolve();
    const newer = store.read();
    second.resolve({ entries: [], revision: "revision-2" as Revision });
    await newer;
    first.resolve({ entries: [], revision: "revision-1" as Revision });
    await older;
    expect(store.getSnapshot()?.revision).toBe("revision-2");
  });

  test("keeps the expected source/type/default table complete and citation-bearing", () => {
    expect(TASK_SETTING_EVIDENCE).toHaveLength(50);
    for (const setting of TASK_SETTING_EVIDENCE) {
      expect(setting.key.length).toBeGreaterThan(0);
      expect(setting.source).toMatch(/\.ts:\d/);
      expect(setting.ompType.length).toBeGreaterThan(0);
    }
  });
});
