import type { ConfigEntry, JsonValue } from "@omp-app/contracts";
import { FolderPath } from "@omp-app/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsRuntime } from "../../../S1/runtime";
import type { IsolationSettingKey, TaskSettingsSectionId } from "../../tasks";
import { TASK_SETTINGS_SECTIONS, TaskSettingsSectionRuntime } from "../../tasks";
import {
  createTaskConfigChangesFixture,
  createTaskConfigStoreFixture,
  TASK_SETTING_EVIDENCE,
} from "./fixtures";

const activeRuntimes: TaskSettingsSectionRuntime[] = [];
const TASK_SECTION_IDS: readonly TaskSettingsSectionId[] = [
  "todos",
  "commandsSkills",
  "isolation",
  "modes",
  "subagents",
];

function createRuntime(
  section: TaskSettingsSectionId,
  folder: FolderPath | null = null,
  layer: "global" | "project" = "global",
) {
  const fixture = createTaskConfigStoreFixture();
  const changes = createTaskConfigChangesFixture();
  const runtime = new SettingsRuntime(fixture.client, changes.source, {
    descriptor: TASK_SETTINGS_SECTIONS[section],
    folder,
    layer,
  });
  const sectionRuntime = new TaskSettingsSectionRuntime(runtime);
  activeRuntimes.push(sectionRuntime);
  return { fixture, runtime: sectionRuntime, changes };
}

afterEach(() => {
  for (const runtime of activeRuntimes.splice(0)) runtime.dispose();
});

const isolationEdits: readonly {
  readonly key: IsolationSettingKey;
  readonly label: string;
  readonly value: JsonValue;
}[] = [
  { key: "task.isolation.enabled", label: "Isolate Subagents", value: true },
  { key: "isolation.backend", label: "Isolation Backend", value: "apfs" },
  { key: "worktree.clone", label: "Clone New Worktrees", value: false },
  {
    key: "worktree.cleanSource",
    label: "Clean Source Checkout When Creating a Worktree",
    value: true,
  },
  { key: "task.isolation.apply", label: "Automatically Apply Isolated Task Changes", value: false },
  { key: "task.isolation.merge", label: "Isolation Merge Strategy", value: "branch" },
  { key: "task.isolation.commits", label: "Isolation Commit Message Style", value: "ai" },
  { key: "worktree.base", label: "Worktree Base Directory", value: "~/omp-worktrees" },
];

describe("S3 Tasks ConfigStore runtime", () => {
  test("reads each Tasks section from S1.2 with the section's keys and default provenance", async () => {
    for (const sectionId of TASK_SECTION_IDS) {
      const { fixture, runtime } = createRuntime(sectionId);
      const snapshot = await runtime.read();
      const expectedKeys: string[] = [];
      for (const control of TASK_SETTINGS_SECTIONS[sectionId].controls) {
        for (const evidence of TASK_SETTING_EVIDENCE) {
          if (evidence.key === control.key && evidence.defaultValue !== undefined) {
            expectedKeys.push(control.key);
          }
        }
      }
      const actualKeys: string[] = [];
      for (const entry of snapshot.entries) {
        actualKeys.push(entry.key);
        if (entry.secret) throw new Error("Task settings must remain non-secret.");
        let hasEvidence = false;
        for (const evidence of TASK_SETTING_EVIDENCE) {
          if (evidence.key === entry.key) {
            expect(entry.value).toEqual(evidence.defaultValue);
            hasEvidence = true;
          }
        }
        expect(hasEvidence).toBe(true);
        expect(entry.source).toBe("default");
        expect(entry.overrides).toEqual([]);
      }
      expect(actualKeys).toEqual(expectedKeys);
      expect(fixture.state.listCalls).toBe(1);
    }
  });

  test("refreshes typed settings when ConfigStore reports an external change", async () => {
    const { fixture, runtime, changes } = createRuntime("subagents");
    await runtime.read();
    let prewalkIndex = -1;
    for (let index = 0; index < fixture.state.entries.length; index += 1) {
      if (fixture.state.entries[index]?.key === "task.prewalk") prewalkIndex = index;
    }
    if (prewalkIndex < 0) throw new Error("Default prewalk setting was not listed.");
    const updated: ConfigEntry = {
      key: "task.prewalk",
      secret: false,
      value: true,
      source: "global",
      overrides: ["default"],
    };
    fixture.state.entries[prewalkIndex] = updated;
    fixture.state.revision = "revision-2";
    changes.emit({
      key: updated.key,
      layer: "global",
      folder: null,
      revision: "revision-2",
      entry: updated,
    });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    const config = runtime.getSnapshot().config;
    if (!config) throw new Error("Settings were not refreshed.");
    let refreshed: ConfigEntry | undefined;
    for (const entry of config.entries) {
      if (entry.key === updated.key) refreshed = entry;
    }
    expect(refreshed).toMatchObject({ value: true, source: "global", overrides: ["default"] });
    expect(config.revision).toBe("revision-2");
    expect(fixture.state.listCalls).toBe(2);
  });

  test("requires explicit confirmation before saving any isolation setting", async () => {
    for (const change of isolationEdits) {
      const { fixture, runtime } = createRuntime("isolation");
      await runtime.read();
      expect(runtime.stage(change.key, { secret: false, value: change.value }).ok).toBe(true);
      const result = await runtime.save();
      expect(result).toMatchObject({
        status: "confirmation-required",
        confirmation: { changes: [change.label] },
      });
      expect(fixture.state.writeCalls).toHaveLength(0);
    }
  });

  test("denial writes nothing; explicit confirmation saves configuration only with CAS", async () => {
    const folder = FolderPath.parse("/workspace/project");
    const { fixture, runtime } = createRuntime("isolation", folder, "project");
    await runtime.read();
    expect(runtime.stage("task.isolation.apply", { secret: false, value: false }).ok).toBe(true);
    const denied = await runtime.save({
      confirmIsolation: async (confirmation) => {
        expect(confirmation.title).toBe("Review task isolation changes");
        expect(confirmation.changes).toEqual(["Automatically Apply Isolated Task Changes"]);
        expect(confirmation.message).toContain("saves configuration only");
        return false;
      },
    });
    expect(denied).toMatchObject({
      status: "cancelled",
      changes: ["Automatically Apply Isolated Task Changes"],
    });
    expect(fixture.state.writeCalls).toHaveLength(0);

    let confirmationWasShown = false;
    const saved = await runtime.save({
      confirmIsolation: async (confirmation) => {
        confirmationWasShown = true;
        expect(confirmation.changes).toEqual(["Automatically Apply Isolated Task Changes"]);
        return true;
      },
    });
    expect(confirmationWasShown).toBe(true);
    expect(saved.status).toBe("saved");
    expect(fixture.state.writeCalls).toHaveLength(1);
    expect(fixture.state.writeCalls[0]).toMatchObject({
      key: "task.isolation.apply",
      layer: "project",
      folder,
      expectedRevision: "revision-1",
      value: { secret: false, value: false },
    });
    let savedEntry: ConfigEntry | undefined;
    for (const entry of fixture.state.entries) {
      if (entry.key === "task.isolation.apply") savedEntry = entry;
    }
    expect(savedEntry).toMatchObject({ secret: false, value: false, source: "project" });
  });

  test("does not apply a confirmation to edits staged while the dialog is open", async () => {
    const { fixture, runtime } = createRuntime("isolation");
    await runtime.read();
    runtime.stage("task.isolation.apply", { secret: false, value: false });
    const result = await runtime.save({
      confirmIsolation: async () => {
        runtime.stage("task.isolation.merge", { secret: false, value: "branch" });
        return true;
      },
    });
    expect(result).toMatchObject({
      status: "stale-confirmation",
      changes: ["Automatically Apply Isolated Task Changes", "Isolation Merge Strategy"],
    });
    expect(fixture.state.writeCalls).toHaveLength(0);
  });

  test("saves live non-isolation policy through ConfigStore without a confirmation", async () => {
    const { fixture, runtime } = createRuntime("subagents");
    await runtime.read();
    const stagedAgents = runtime.stage("task.disabledAgents", {
      secret: false,
      value: ["scout"],
    });
    expect(stagedAgents.ok).toBe(true);
    const result = await runtime.save();
    expect(result.status).toBe("saved");
    expect(fixture.state.writeCalls).toHaveLength(1);
    expect(fixture.state.writeCalls[0]).toMatchObject({
      key: "task.disabledAgents",
      layer: "global",
      folder: null,
      expectedRevision: "revision-1",
      value: { secret: false, value: ["scout"] },
    });
  });

  test("saves the typed model map through S1 one-key CAS", async () => {
    const { fixture, runtime } = createRuntime("subagents");
    await runtime.read();
    expect(
      runtime.stage("task.agentModelOverrides", {
        secret: false,
        value: { task: ["@fast", "provider/model"] },
      }).ok,
    ).toBe(true);
    const result = await runtime.save();
    expect(result.status).toBe("saved");
    expect(fixture.state.writeCalls).toHaveLength(1);
    expect(fixture.state.writeCalls[0]).toMatchObject({
      key: "task.agentModelOverrides",
      layer: "global",
      folder: null,
      expectedRevision: "revision-1",
      value: { secret: false, value: { task: ["@fast", "provider/model"] } },
    });
  });
});
