import { describe, expect, test } from "vitest";
import { MODEL_ROLE_DEFINITIONS, roleDefinitions } from "./role-list";

/** omp v18.12.6 `MODEL_ROLE_IDS`: packages/tui/src/overlays/model-browser.ts:72-89. */
const OMP_ROLE_IDS = [
  "default",
  "smol",
  "slow",
  "vision",
  "plan",
  "commit",
  "tiny",
  "memory",
  "task",
  "advisor",
  "widget",
  "image",
  "web",
  "speech",
  "dictation",
  "judge",
];

describe("the model roles listed", () => {
  test("are omp 18.12.6's roles in omp's order, with Job widgets right after Advisor", () => {
    expect(MODEL_ROLE_DEFINITIONS.map((role) => role.id)).toEqual(OMP_ROLE_IDS);
    const ids = MODEL_ROLE_DEFINITIONS.map((role) => role.id);
    expect(ids.indexOf("widget")).toBe(ids.indexOf("advisor") + 1);
  });

  test("name the widget role as omp does, and let a chat model take it", () => {
    // omp v18.12.6 packages/coding-agent/src/config/model-roles.ts:67: tag WIDGET, name "Job widgets", section chat.
    expect(MODEL_ROLE_DEFINITIONS.find((role) => role.id === "widget")).toEqual({
      id: "widget",
      name: "Job widgets",
      kind: false,
      unpickableReason: null,
    });
  });

  test("keep a configured role omp lists once, and add a custom role after the built-ins", () => {
    const roles = roleDefinitions(["widget", "review"]);
    expect(roles.filter((role) => role.id === "widget")).toHaveLength(1);
    expect(roles.map((role) => role.id)).toEqual([...OMP_ROLE_IDS, "review"]);
  });
});
