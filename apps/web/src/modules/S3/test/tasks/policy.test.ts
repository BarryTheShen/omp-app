import type { ConfigEntry } from "@omp-app/contracts";
import { AppFailure, FolderPath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { readTasksPolicySnapshot } from "../../tasks";
import { createTaskConfigStoreFixture, TASK_SETTING_EVIDENCE } from "./fixtures";

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

  test("rejects missing or malformed required values without echoing config data", async () => {
    const missing = createTaskConfigStoreFixture();
    const retainedEntries: ConfigEntry[] = [];
    for (const entry of missing.state.entries) {
      if (entry.key !== "task.agentAdvisor") retainedEntries.push(entry);
    }
    missing.state.entries = retainedEntries;
    await expect(readTasksPolicySnapshot(missing.client, null)).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "host.config" },
    });

    const malformedTier = createTaskConfigStoreFixture();
    const tierIndex = settingIndex(malformedTier.state.entries, "task.agentServiceTierOverrides");
    const tierEntry = malformedTier.state.entries[tierIndex];
    if (!tierEntry || tierEntry.secret)
      throw new Error("Default service-tier setting was not listed.");
    malformedTier.state.entries[tierIndex] = {
      ...tierEntry,
      value: { task: "fast" },
    };
    await expect(readTasksPolicySnapshot(malformedTier.client, null)).rejects.toBeInstanceOf(
      AppFailure,
    );
    await expect(readTasksPolicySnapshot(malformedTier.client, null)).rejects.toThrow(
      "The task settings service returned an invalid value.",
    );

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
    await expect(readTasksPolicySnapshot(secret.client, null)).rejects.toThrow(
      "The task settings service did not return the complete policy.",
    );
  });

  test("keeps the expected source/type/default table complete and citation-bearing", () => {
    expect(TASK_SETTING_EVIDENCE).toHaveLength(46);
    for (const setting of TASK_SETTING_EVIDENCE) {
      expect(setting.key.length).toBeGreaterThan(0);
      expect(setting.source).toMatch(/\.ts:\d/);
      expect(setting.ompType.length).toBeGreaterThan(0);
    }
  });
});
