import { describe, expect, test } from "vitest";
import type { ConfigSnapshot, SettingControl, SettingValue } from "../../../S1/settings-kit";
import { S3_SETTINGS_SECTIONS, TASKS_ISOLATION_SECTION } from "../../sections";
import { TASK_SETTINGS_SECTIONS } from "../../tasks";
import { TASK_SETTING_EVIDENCE } from "./fixtures";

const snapshot: ConfigSnapshot = { folder: null, revision: "revision-1", entries: [] };

function settingControls(): SettingControl[] {
  const controls: SettingControl[] = [];
  for (const section of Object.values(TASK_SETTINGS_SECTIONS)) {
    for (const control of section.controls) controls.push(control);
  }
  return controls;
}

function controlFor(key: string): SettingControl {
  for (const control of settingControls()) {
    if (control.key === key) return control;
  }
  throw new Error(`Missing Tasks setting ${key}`);
}

function valid(control: SettingControl, value: SettingValue) {
  return control.validate(value, snapshot);
}

describe("S3 Tasks settings", () => {
  test("covers every v18.6.1 Tasks key with its source registration and exact control kind", () => {
    const actualKeys: string[] = [];
    for (const control of settingControls()) actualKeys.push(control.key);
    const expectedKeys: string[] = [];
    for (const evidence of TASK_SETTING_EVIDENCE) expectedKeys.push(evidence.key);
    expect(actualKeys).toEqual(expectedKeys);
    for (const evidence of TASK_SETTING_EVIDENCE) {
      expect(evidence.source).toMatch(/^packages\/coding-agent\/src\/.+:\d/);
      expect(controlFor(evidence.key).kind).toBe(evidence.controlKind);
    }
    let taskRowCount = 0;
    for (const section of S3_SETTINGS_SECTIONS) {
      let taskRow = false;
      for (const id of section.inventory) {
        if (id.startsWith("S5.tasks-") || id === "S5.tools-todos") taskRow = true;
      }
      if (taskRow) taskRowCount += 1;
    }
    expect(taskRowCount).toBe(5);
  });

  test("uses the exact list and live control for disabled agents and the resolved-model badge", () => {
    const disabledAgents = controlFor("task.disabledAgents");
    expect(disabledAgents.kind).toBe("list");
    expect(disabledAgents.apply).toBe("live");
    expect(valid(disabledAgents, { secret: false, value: ["scout", "task"] })).toEqual({
      valid: true,
    });
    expect(valid(disabledAgents, { secret: false, value: ["scout", 4] })).toMatchObject({
      valid: false,
      code: "array",
    });
    const badge = controlFor("task.showResolvedModelBadge");
    expect(badge.kind).toBe("boolean");
    expect(badge.apply).toBe("live");
    expect(valid(badge, { secret: false, value: false })).toEqual({ valid: true });
  });

  test("uses the S1 list-field editor for model selectors and validates all map value shapes", () => {
    const modelOverrides = controlFor("task.agentModelOverrides");
    if (modelOverrides.kind !== "map")
      throw new Error("Model overrides must use the S1 map control.");
    expect(modelOverrides.value.kind).toBe("list");
    if (modelOverrides.value.kind !== "list")
      throw new Error("Model selectors must use a list field.");
    expect(modelOverrides.value.collapseSingle).toBe(true);
    expect(modelOverrides.value.placeholder).toBe("provider/model, provider/model");
    expect(modelOverrides.readOnly).toBeUndefined();
    expect(modelOverrides.apply).toBe("live");
    expect(
      valid(modelOverrides, {
        secret: false,
        value: { task: ["@slow", "provider/model"], scout: "provider/fast" },
      }),
    ).toEqual({ valid: true });
    expect(
      valid(modelOverrides, { secret: false, value: { task: ["provider/model", 3] } }),
    ).toMatchObject({ valid: false, code: "map" });

    const tiers = controlFor("task.agentServiceTierOverrides");
    if (tiers.kind !== "map")
      throw new Error("Service-tier overrides must use the S1 map control.");
    expect(tiers.value.kind).toBe("enum");
    expect(tiers.readOnly).toBeUndefined();
    expect(tiers.apply).toBe("live");
    expect(
      valid(tiers, { secret: false, value: { task: "inherit", reviewer: "priority" } }),
    ).toEqual({ valid: true });
    expect(valid(tiers, { secret: false, value: { task: "fast" } })).toMatchObject({
      valid: false,
      code: "map",
    });

    const thresholds = controlFor("task.agentCompactionThresholdOverrides");
    if (thresholds.kind !== "map")
      throw new Error("Compaction thresholds must use the S1 map control.");
    expect(thresholds.readOnly?.reason).toContain("token counts or percentages");
    expect(thresholds.apply).toBe("live");
    expect(
      valid(thresholds, { secret: false, value: { task: 90_000, scout: "80.5%", reviewer: null } }),
    ).toEqual({ valid: true });
    expect(valid(thresholds, { secret: false, value: { task: "101%" } })).toMatchObject({
      valid: false,
      code: "map",
    });

    const prewalk = controlFor("task.agentPrewalk");
    if (prewalk.kind !== "map") throw new Error("Prewalk overrides must use the S1 map control.");
    expect(prewalk.value.kind).toBe("text");
    expect(prewalk.apply).toBe("live");
    expect(valid(prewalk, { secret: false, value: { task: "on", scout: "off" } })).toEqual({
      valid: true,
    });
    const advisor = controlFor("task.agentAdvisor");
    if (advisor.kind !== "map") throw new Error("Advisor overrides must use the S1 map control.");
    expect(advisor.value.kind).toBe("text");
    expect(advisor.apply).toBe("live");
    expect(valid(advisor, { secret: false, value: { task: "on", reviewer: "off" } })).toEqual({
      valid: true,
    });
  });

  test("labels isolation effects and states that saving configuration never mutates a worktree", () => {
    const keys = [
      "task.isolation.enabled",
      "isolation.backend",
      "worktree.clone",
      "worktree.cleanSource",
      "task.isolation.apply",
      "task.isolation.merge",
      "task.isolation.commits",
      "worktree.base",
    ];
    for (const key of keys) {
      const control = controlFor(key);
      const safetyText = `${control.label} ${control.description ?? ""}`;
      expect(control.description).toContain("Saving");
      expect(safetyText).toMatch(/worktree|checkout|isolation/i);
      expect(safetyText).not.toContain(key);
    }
    expect(controlFor("worktree.cleanSource").description).toContain("Destructive");
    expect(controlFor("task.isolation.apply").description).toContain("Destructive");
    expect(TASKS_ISOLATION_SECTION.requires).toEqual(["host.config"]);
  });
});
