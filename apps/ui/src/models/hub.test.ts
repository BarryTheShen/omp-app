import type { HubModel, HubRole, ModelHub } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import { assignLevel, modelsFor, roleGroups, roleValueText, windowText } from "./hub";

function role(patch: Partial<HubRole> & Pick<HubRole, "role">): HubRole {
  return {
    tag: patch.role.toUpperCase(),
    name: patch.role,
    section: "chat",
    value: null,
    provenance: "default",
    model: null,
    thinkingLevel: null,
    autoSelected: false,
    fallbacks: [],
    ...patch,
  };
}

function model(patch: Partial<HubModel> & Pick<HubModel, "modelId">): HubModel {
  return {
    provider: "fake",
    name: patch.modelId,
    contextWindow: 200_000,
    reasoning: true,
    thinkingLevels: ["inherit", "off", "auto", "low", "medium", "high"],
    roles: ["default", "smol", "slow"],
    ...patch,
  };
}

const fable = { provider: "fake", modelId: "claude-fable-5", name: "Claude Fable 5" };

describe("the level an assignment keeps", () => {
  test("a role with a model of its own keeps its level where the new model can apply it", () => {
    const smol = role({
      role: "smol",
      model: fable,
      thinkingLevel: "high",
      value: "fake/claude-fable-5:high",
    });
    expect(assignLevel(smol, model({ modelId: "other" }))).toBe("high");
    expect(
      assignLevel(smol, model({ modelId: "plain", reasoning: false, thinkingLevels: [] })),
    ).toBe("inherit");
    expect(
      assignLevel(smol, model({ modelId: "no-high", thinkingLevels: ["inherit", "off", "low"] })),
    ).toBe("inherit");
  });

  test("a role on omp's auto-selection, or without a model, starts from inherit", () => {
    const auto = role({ role: "slow", model: fable, thinkingLevel: "high", autoSelected: true });
    expect(assignLevel(auto, model({ modelId: "other" }))).toBe("inherit");
    expect(assignLevel(role({ role: "plan" }), model({ modelId: "other" }))).toBe("inherit");
  });
});

describe("a role's model as the Roles view writes it", () => {
  test("its own model, omp's auto-selection, or a dash", () => {
    expect(roleValueText(role({ role: "smol", model: fable }))).toBe("fake/claude-fable-5");
    expect(roleValueText(role({ role: "slow", model: fable, autoSelected: true }))).toBe(
      "auto → fake/claude-fable-5",
    );
    expect(roleValueText(role({ role: "image", section: "kind" }))).toBe("—");
  });
});

describe("the models a role takes", () => {
  const hub: ModelHub = {
    storage: "global",
    current: null,
    roles: [role({ role: "default" }), role({ role: "image", section: "kind" })],
    models: [
      model({ modelId: "claude-fable-5", name: "Claude Fable 5" }),
      model({ modelId: "claude-3-haiku-20240307", name: "Claude Haiku 3" }),
      model({ modelId: "painter", name: "Painter", roles: ["image"] }),
    ],
    presets: { names: [], active: null },
  };

  test("only the ones the role accepts, in the hub's order, matching every word searched", () => {
    expect(modelsFor(hub, "default", "").map((each) => each.modelId)).toEqual([
      "claude-fable-5",
      "claude-3-haiku-20240307",
    ]);
    expect(modelsFor(hub, "image", "").map((each) => each.modelId)).toEqual(["painter"]);
    expect(modelsFor(hub, "default", "HAIKU fake/").map((each) => each.modelId)).toEqual([
      "claude-3-haiku-20240307",
    ]);
    expect(modelsFor(hub, "default", "haiku fable")).toEqual([]);
  });

  test("the roles come in omp's two groups, an empty group left out", () => {
    expect(
      roleGroups(hub).map((group) => [group.title, group.roles.map((each) => each.role)]),
    ).toEqual([
      ["Chat", ["default"]],
      ["Kinds", ["image"]],
    ]);
    expect(
      roleGroups({ ...hub, roles: [role({ role: "default" })] }).map((group) => group.title),
    ).toEqual(["Chat"]);
  });
});

describe("a context window in a few characters", () => {
  test("thousands and millions, nothing when unknown", () => {
    expect(windowText(200_000)).toBe("200k");
    expect(windowText(1_048_576)).toBe("1M");
    expect(windowText(1_500_000)).toBe("1.5M");
    expect(windowText(null)).toBe("");
  });
});
