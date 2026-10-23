import { AppFailure, type CapabilityMap, CapabilityStatus, type OmpWire } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ModelDescriptor, ModelRef } from "../contract";
import { ModelCatalogModel, toModelDescriptor } from "./catalog";
import type { RoleCycleDeps, RoleCycleSettings } from "./role-cycle";
import { cycleRoleModel, nextRoleEntry, resolveRoleCycle } from "./role-cycle";

const ORDER = ["smol", "default", "slow"];

/** omp's wire record for one model, as get_available_models lists it. */
function wire(id: string, provider = "fake"): OmpWire.ModelInfo {
  return {
    provider,
    id,
    name: `Model ${id}`,
    api: "chat-completions",
    baseUrl: "https://provider.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

const A = toModelDescriptor(wire("a"));
const B = toModelDescriptor(wire("b"));
const C = toModelDescriptor(wire("c"));
const LOCKED = toModelDescriptor(wire("locked", "locked"), {
  lockedProviders: new Set(["locked"]),
});
const MODELS: readonly ModelDescriptor[] = [A, B, C, LOCKED];

function ref(model: ModelDescriptor): ModelRef {
  return { provider: model.provider, modelId: model.id };
}

function settings(
  modelRoles: RoleCycleSettings["modelRoles"],
  cycleOrder: readonly string[] = ORDER,
): RoleCycleSettings {
  return { modelRoles, cycleOrder };
}

/** The role one step from `current`, or null when the cycle has nothing to step to. */
function stepFrom(
  roles: RoleCycleSettings,
  current: ModelRef | null,
  direction: "forward" | "backward",
): string | null {
  return nextRoleEntry(resolveRoleCycle(roles, MODELS, current), direction)?.role ?? null;
}

describe("D1 role cycle resolution", () => {
  const THREE = settings({ smol: "fake/a", default: "fake/b", slow: "fake/c" });

  test("follows the cycle order and wraps at both ends, in both directions", () => {
    expect(stepFrom(THREE, ref(A), "forward")).toBe("default");
    expect(stepFrom(THREE, ref(B), "forward")).toBe("slow");
    expect(stepFrom(THREE, ref(C), "forward")).toBe("smol");
    expect(stepFrom(THREE, ref(A), "backward")).toBe("slow");
    expect(stepFrom(THREE, ref(C), "backward")).toBe("default");
  });

  test("steps through the roles in the order the settings name, whatever order they are set in", () => {
    const reordered = settings({ slow: "fake/c", smol: "fake/a", default: "fake/b" }, [
      "slow",
      "smol",
      "default",
    ]);
    const cycle = resolveRoleCycle(reordered, MODELS, ref(C));
    expect(cycle.entries.map((entry) => entry.role)).toEqual(["slow", "smol", "default"]);
    expect(stepFrom(reordered, ref(C), "forward")).toBe("smol");
  });

  test("skips a role with no selector, a model that is not available, and a selector that is not provider/model", () => {
    const mixed = settings(
      { smol: "fake/a", default: "locked/locked", slow: "fake/c", vision: "not-a-model-pair" },
      [...ORDER, "vision", "tiny"],
    );
    const cycle = resolveRoleCycle(mixed, MODELS, ref(A));
    expect(cycle.entries.map((entry) => entry.role)).toEqual(["smol", "slow"]);
    expect(stepFrom(mixed, ref(A), "forward")).toBe("slow");
    expect(stepFrom(mixed, ref(C), "forward")).toBe("smol");
  });

  test("an unset default role stands for the current model, as omp's does", () => {
    const noDefault = settings({ smol: "fake/a", slow: "fake/c" });
    const cycle = resolveRoleCycle(noDefault, MODELS, ref(B));
    expect(cycle.entries.map((entry) => entry.role)).toEqual(["smol", "default", "slow"]);
    expect(cycle.entries[cycle.currentIndex]?.role).toBe("default");
    expect(stepFrom(noDefault, ref(B), "forward")).toBe("slow");
    expect(stepFrom(noDefault, ref(B), "backward")).toBe("smol");
  });

  test("a current model outside the roles starts at the first role", () => {
    const outside = toModelDescriptor(wire("elsewhere"));
    const listed = [...MODELS, outside];
    expect(resolveRoleCycle(THREE, listed, ref(outside)).currentIndex).toBe(0);
    expect(nextRoleEntry(resolveRoleCycle(THREE, listed, ref(outside)), "forward")?.role).toBe(
      "default",
    );
    expect(nextRoleEntry(resolveRoleCycle(THREE, listed, ref(outside)), "backward")?.role).toBe(
      "slow",
    );
  });

  test("a model that two roles name starts at the first of them", () => {
    const shared = settings({ smol: "fake/a", default: "fake/a", slow: "fake/c" });
    const cycle = resolveRoleCycle(shared, MODELS, ref(A));
    expect(cycle.currentIndex).toBe(0);
    expect(stepFrom(shared, ref(A), "forward")).toBe("default");
  });

  test("the role last applied is the position while its model is current, so two roles on one model do not loop", () => {
    const shared = settings({ smol: "fake/a", default: "fake/a", slow: "fake/c" });
    // The last step applied `default`, whose model is the session's: the next step goes on to `slow`, not back to `default`.
    expect(resolveRoleCycle(shared, MODELS, ref(A), "default").currentIndex).toBe(1);
    expect(
      nextRoleEntry(resolveRoleCycle(shared, MODELS, ref(A), "default"), "forward")?.role,
    ).toBe("slow");
    // A recorded role whose model is no longer the session's (another surface changed it) is ignored.
    expect(resolveRoleCycle(shared, MODELS, ref(C), "default").currentIndex).toBe(2);
  });

  test("a level in a selector is the role's thinking level; auto and inherit name none", () => {
    const levels = settings({
      smol: "fake/a:high",
      default: "fake/b:auto",
      slow: "fake/c:inherit",
    });
    const cycle = resolveRoleCycle(levels, MODELS, ref(A));
    expect(cycle.entries.map((entry) => entry.thinkingLevel)).toEqual(["high", null, null]);
  });

  test("with fewer than two resolvable roles there is no step", () => {
    expect(stepFrom(settings({ smol: "fake/a" }), null, "forward")).toBeNull();
    expect(stepFrom(settings({}), ref(A), "forward")).toBeNull();
  });
});

/** A catalog over omp's listed models, and a record of the calls the step makes. */
function harness(options: {
  readonly start: ModelRef | null;
  readonly roles: RoleCycleSettings;
  readonly failSet?: boolean;
  readonly refuseLevel?: boolean;
}) {
  const calls: string[] = [];
  let current = options.start;
  const capabilities: CapabilityMap = {
    "omp.cmd.get_available_models": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    "omp.cmd.set_model": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  };
  const catalog = new ModelCatalogModel({
    source: {
      getAvailableModels: async () => {
        calls.push("get_available_models");
        return [wire("a"), wire("b"), wire("c")];
      },
      setModel: async (model) => {
        calls.push(`set_model ${model.provider}/${model.modelId}`);
        if (options.failSet) {
          throw new AppFailure({
            code: "internal",
            message: "omp refused the model.",
            retryable: false,
          });
        }
        current = model;
        return wire(model.modelId);
      },
    },
    capabilities,
    liveState: { getSnapshot: () => ({ model: current }), subscribe: () => () => undefined },
  });
  const deps: RoleCycleDeps = {
    lastRole: null,
    catalog,
    readSettings: async () => {
      calls.push("read_settings");
      return options.roles;
    },
    readSession: async () => {
      calls.push("read_session");
    },
    setThinkingLevel: async (level) => {
      calls.push(`set_thinking ${level}`);
      if (options.refuseLevel) {
        throw new AppFailure({
          code: "invalid_args",
          message: "That thinking level is not supported by the current model.",
          retryable: false,
        });
      }
    },
  };
  return { calls, deps, catalog };
}

describe("D1 role cycle step", () => {
  const THREE = settings({ smol: "fake/a", default: "fake/b", slow: "fake/c" });

  test("sets the next role's model, then reads the session again, and sets no thinking level", async () => {
    const { calls, deps, catalog } = harness({ start: ref(A), roles: THREE });

    expect(await cycleRoleModel(deps, "forward")).toEqual({
      kind: "changed",
      role: "default",
      thinkingError: null,
    });
    expect(catalog.getSnapshot().current).toEqual(ref(B));
    expect(calls).toEqual([
      "get_available_models",
      "read_settings",
      "set_model fake/b",
      "read_session",
    ]);
  });

  test("sets the role's thinking level after its model, and reads the session again after it", async () => {
    const levelled = settings({ smol: "fake/a", default: "fake/b", slow: "fake/c:high" });
    const { calls, deps, catalog } = harness({ start: ref(B), roles: levelled });

    expect(await cycleRoleModel(deps, "forward")).toEqual({
      kind: "changed",
      role: "slow",
      thinkingError: null,
    });
    expect(catalog.getSnapshot().current).toEqual(ref(C));
    expect(calls).toEqual([
      "get_available_models",
      "read_settings",
      "set_model fake/c",
      "read_session",
      "set_thinking high",
      "read_session",
    ]);
  });

  test("a level the model refuses is returned as text, and the new model stays", async () => {
    const levelled = settings({ smol: "fake/a", default: "fake/b", slow: "fake/c:high" });
    const { calls, deps, catalog } = harness({ start: ref(B), roles: levelled, refuseLevel: true });

    expect(await cycleRoleModel(deps, "forward")).toEqual({
      kind: "changed",
      role: "slow",
      thinkingError:
        "The model changed, but its thinking level could not be set: That thinking level is not supported by the current model.",
    });
    expect(catalog.getSnapshot().current).toEqual(ref(C));
    expect(calls.at(-1)).toBe("set_thinking high");
  });

  test("with fewer than two roles it says so and changes nothing", async () => {
    // The session is on a locked model, so the unset default role resolves to nothing: one role is left.
    const { calls, deps, catalog } = harness({
      start: ref(LOCKED),
      roles: settings({ smol: "fake/a" }),
    });

    expect(await cycleRoleModel(deps, "forward")).toEqual({ kind: "single" });
    expect(catalog.getSnapshot().current).toEqual(ref(LOCKED));
    expect(calls).toEqual(["get_available_models", "read_settings"]);
  });

  test("a model change omp refuses throws, and nothing after it runs", async () => {
    const { calls, deps } = harness({ start: ref(A), roles: THREE, failSet: true });

    await expect(cycleRoleModel(deps, "forward")).rejects.toMatchObject({
      appError: { message: "omp refused the model." },
    });
    expect(calls).toEqual(["get_available_models", "read_settings", "set_model fake/b"]);
  });
});
