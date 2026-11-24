import { describe, expect, test } from "vitest";
import { type Current, type OmpKey, planFor, presetFor } from "./plan";

const omp = (
  values: Partial<Record<OmpKey, [string | number | boolean, boolean]>>,
): Current["omp"] =>
  new Map(
    Object.entries(values).map(([key, [value, theirs]]) => [key as OmpKey, { value, theirs }]),
  );

const DEFAULTS: Current = {
  browser: { themeMode: "system", style: "tern", groupTools: true, closeAfter: 12 },
  omp: omp({
    defaultThinkingLevel: ["high", false],
    "tools.approvalMode": ["yolo", false],
    "todo.eager": ["default", false],
    "task.autoParallel": ["off", false],
    "retry.waitForUsageReset": [false, false],
  }),
  notifying: false,
};

describe("the setup's plan", () => {
  test("several uses ask for the most careful approval and the most thinking of them", () => {
    expect(presetFor(["parallel", "study"])).toMatchObject({
      "tools.approvalMode": "always-ask",
      defaultThinkingLevel: "medium",
      "task.autoParallel": "suggest",
    });
    expect(presetFor(["writing", "coding"])).toMatchObject({
      "tools.approvalMode": "write",
      defaultThinkingLevel: "high",
    });
    expect(presetFor(["trying"])).toEqual({});
  });

  test("lists only what changes; an answer outranks the preset; a value the person set is marked theirs", () => {
    const current: Current = {
      ...DEFAULTS,
      omp: omp({
        defaultThinkingLevel: ["low", true],
        "tools.approvalMode": ["yolo", false],
        "retry.waitForUsageReset": [false, false],
      }),
    };
    const plan = planFor(
      { uses: ["writing"], approval: "always-ask", themeMode: "dark", groupTools: true },
      current,
    );
    expect(plan.changes).toEqual([
      { where: "browser", setting: "themeMode", from: "system", to: "dark" },
      { where: "omp", key: "defaultThinkingLevel", from: "low", to: "medium", theirs: true },
      { where: "omp", key: "tools.approvalMode", from: "yolo", to: "always-ask", theirs: false },
    ]);
  });

  test("questions skipped change nothing; sign-in is always a step, notifications only when asked and not on", () => {
    expect(planFor({}, DEFAULTS)).toEqual({ changes: [], steps: ["sign-in"] });
    expect(planFor({ notify: true, devices: ["computer", "phone"] }, DEFAULTS).steps).toEqual([
      "notifications",
      "notifications-elsewhere",
      "sign-in",
    ]);
    expect(planFor({ notify: true }, { ...DEFAULTS, notifying: true }).steps).toEqual(["sign-in"]);
  });
});
