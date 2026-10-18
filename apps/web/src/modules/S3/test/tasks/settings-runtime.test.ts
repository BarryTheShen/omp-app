import type { ConfigEntry, FolderPath } from "@omp-app/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsRuntime } from "../../../S1/runtime";
import type { TaskSettingsSectionId } from "../../tasks";
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
