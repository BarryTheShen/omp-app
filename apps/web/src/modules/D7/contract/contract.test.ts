import type { CapabilityMap } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  D7_AP6_CAPABILITY,
  D7_AP6_REASON,
  effectiveModeState,
  FastModeState,
  ModeCommandResult,
  ModeSnapshot,
  ModeState,
  modeCapability,
  modeState,
  resolveModePrecedence,
  resolvePrecedence,
  ToolAvailability,
  toolAvailability,
  unavailableMode,
} from ".";

const available: CapabilityMap = {
  "host.command-gateway": { state: "available", via: "host" },
  "omp.cmd.set_fast_mode": { state: "available", via: "rpc" },
  "omp.cmd.get_state": { state: "available", via: "rpc" },
};

describe("D7 mode contracts", () => {
  test("preserves unknown/requested state instead of reducing it to a boolean", () => {
    const requested = ModeState.parse({
      mode: "browser",
      state: "requested",
      scope: "command",
      source: "omp-command",
      requested: true,
      reason: "Waiting for the command result",
    });
    expect(requested.state).toBe("requested");
    expect(requested.requested).toBe(true);
    expect(
      ModeState.safeParse({
        mode: "browser",
        state: "unavailable",
        scope: "session",
        source: "upstream",
      }).success,
    ).toBe(false);
  });

  test("keeps provider fast-enabled and fast-active values distinct", () => {
    const fast = FastModeState.parse({
      enabled: true,
      active: false,
      state: "fallback",
      scope: "session",
      source: "omp-rpc",
      capability: "omp.cmd.set_fast_mode",
      reason: "The provider does not expose a fast tier.",
    });
    expect(fast.enabled).toBe(true);
    expect(fast.active).toBe(false);
    expect(fast.state).toBe("fallback");
  });

  test("safe command results carry the mode, command and typed failure", () => {
    const result = ModeCommandResult.parse({
      ok: false,
      command: "/extended-context on",
      mode: "extended-context",
      state: "unavailable",
      capability: D7_AP6_CAPABILITY,
      reason: D7_AP6_REASON,
      error: { code: "unavailable", message: D7_AP6_REASON, retryable: false },
    });
    expect(result.error?.code).toBe("unavailable");
    expect(result.capability).toBe(D7_AP6_CAPABILITY);
  });
});

describe("D7 precedence and capability gates", () => {
  test("command scope wins over session/settings/default without hiding records", () => {
    const states = [
      modeState("default", "default", "config", "known", available),
      modeState("fast", "settings", "config", "known", available, {
        enabled: false,
        active: false,
      }),
      modeState("fast", "session", "omp-rpc", "known", available, { enabled: true, active: true }),
      modeState("fast", "command", "omp-command", "requested", available, { requested: true }),
    ];
    const records = resolveModePrecedence(states);
    expect(records[0]).toMatchObject({ mode: "fast", scope: "command", priority: 4 });
    expect(records).toHaveLength(4);
    expect(effectiveModeState(states, "fast")?.scope).toBe("command");
  });
  test("accepts higher-priority external slots without taking ownership of them", () => {
    const records = resolvePrecedence([
      { slot: "d7", mode: "fast", priority: 4, state: "known" },
      { slot: "d8", mode: "goal", priority: 8, state: "known" },
      { slot: "p2", mode: "advisor", priority: 7, state: "requested" },
    ]);
    expect(records.map((record) => record.slot)).toEqual(["d8", "p2", "d7"]);
  });

  test("AP6 modes are visibly unavailable with a stable reason", () => {
    const state = unavailableMode("prewalk", "session", "upstream");
    expect(state).toMatchObject({
      mode: "prewalk",
      state: "unavailable",
      capability: D7_AP6_CAPABILITY,
      reason: D7_AP6_REASON,
    });
  });

  test("fallback capability remains usable and missing capability is unavailable", () => {
    const fallback: CapabilityMap = {
      "host.command-gateway": { state: "fallback", via: "host", detail: "read-only" },
    };
    expect(modeCapability("browser")).toBe("host.command-gateway");
    expect(modeState("browser", "command", "omp-command", "requested", fallback)).toMatchObject({
      state: "fallback",
      capability: "host.command-gateway",
    });
    expect(
      toolAvailability("computer", {}, { capability: "host.command-gateway", mode: "computer" }),
    ).toMatchObject({
      state: "unavailable",
      capability: "host.command-gateway",
    });
  });

  test("mode snapshot schema carries mode, fast, precedence and tool availability together", () => {
    const mode = modeState("default", "default", "client", "known", {});
    const tool = ToolAvailability.parse({ tool: "bash", state: "unknown" });
    const snapshot = ModeSnapshot.parse({
      modes: { default: mode },
      fast: {
        enabled: false,
        active: false,
        state: "known",
        scope: "session",
        source: "omp-rpc",
      },
      precedence: resolveModePrecedence([mode]),
      tools: [tool],
      revision: 0,
    });
    expect(snapshot.tools[0]?.state).toBe("unknown");
    expect(snapshot.fast.active).toBe(false);
  });
});
