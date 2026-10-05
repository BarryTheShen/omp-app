import { CapabilityStatus } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { ThinkingLevelsController } from "./thinking";

const capabilities = {
  "omp.cmd.get_available_thinking_levels": CapabilityStatus.parse({
    state: "available",
    via: "rpc",
  }),
  "omp.cmd.set_thinking_level": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  "omp.cmd.cycle_thinking_level": CapabilityStatus.parse({ state: "available", via: "rpc" }),
};

function source(calls: string[]) {
  return {
    getAvailableLevels: async () => ["low", "medium", "high"] as const,
    setLevel: async (level: string) => {
      calls.push(`set:${level}`);
    },
    cycleLevel: async () => {
      calls.push("cycle");
      return { level: "high" as const };
    },
  };
}

describe("D1 thinking levels", () => {
  test("loads off plus model-supported levels and applies one session level", async () => {
    const calls: string[] = [];
    const controller = new ThinkingLevelsController({ source: source(calls), capabilities });
    await controller.refresh();
    expect(controller.getSnapshot().levels).toEqual(["off", "low", "medium", "high"]);
    await controller.apply({ level: "high", scope: "session" });
    expect(calls).toEqual(["set:high"]);
    controller.dispose();
  });

  test("keeps reasoning=false models visibly unavailable and never guesses levels", async () => {
    const calls: string[] = [];
    const controller = new ThinkingLevelsController({
      source: source(calls),
      capabilities,
      live: {
        getSnapshot: () => ({ current: null, configured: null, reasoning: false }),
        subscribe: () => () => undefined,
      },
    });
    await controller.refresh();
    expect(controller.getSnapshot().levels).toEqual([]);
    await expect(controller.apply({ level: "high", scope: "session" })).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    expect(calls).toEqual([]);
    controller.dispose();
  });

  test("cycles forward through omp and backward with explicit set", async () => {
    const calls: string[] = [];
    const controller = new ThinkingLevelsController({
      source: source(calls),
      capabilities,
      live: {
        getSnapshot: () => ({ current: "medium", configured: "auto", reasoning: true }),
        subscribe: () => () => undefined,
      },
    });
    await controller.refresh();
    await controller.cycle("forward");
    await controller.cycle("backward");
    expect(calls).toEqual(["cycle", "set:medium"]);
    controller.dispose();
  });
});
