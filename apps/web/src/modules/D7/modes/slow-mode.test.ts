import {
  AppFailure,
  type CapabilityMap,
  CapabilityStatus,
  type ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { GetStateResult, ModeRpc } from "../contract";
import { ModeController } from "./controller";
import { SLOW_UNSUPPORTED_TEXT } from "./slow";

const threadId = "d7-slow-thread" as ThreadId;

function capabilities(overrides: CapabilityMap = {}): CapabilityMap {
  return {
    "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
    "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    "omp.cmd.set_slow_mode": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    ...overrides,
  };
}

/** omp's get_state with the Slow mode fields given, and the Fast mode fields a read always carries. */
function stateWith(slow: Partial<GetStateResult>): GetStateResult {
  return { sessionId: "session", fastModeEnabled: false, fastModeActive: false, ...slow };
}

/**
 * A mode RPC whose get_state answers `state()` and whose set_slow_mode answers `setSlow`. Each change sent to omp
 * is recorded, and so is each read, so a test can say what reached omp.
 */
function rpcFake(options: {
  readonly state?: () => GetStateResult | Promise<GetStateResult>;
  readonly setSlow?: (enabled: boolean) => Promise<{ readonly enabled: boolean }>;
}) {
  const setCalls: boolean[] = [];
  let reads = 0;
  const rpc: ModeRpc = {
    getState: async () => {
      reads += 1;
      return (options.state ?? (() => stateWith({})))();
    },
    setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
    setSlowMode: async ({ enabled }) => {
      setCalls.push(enabled);
      return options.setSlow ? options.setSlow(enabled) : { enabled };
    },
  };
  return { rpc, setCalls, readCount: () => reads };
}

describe("Slow mode as omp's get_state reports it", () => {
  test("a model without slow mode is unavailable, with the plain reason, and neither choice is set", async () => {
    const { rpc } = rpcFake({
      state: () => stateWith({ slowModeSupported: false, slowModeEnabled: false }),
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    await controller.refresh();
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "unavailable",
      reason: SLOW_UNSUPPORTED_TEXT,
    });
    expect(controller.getSnapshot().modes.slow?.requested).toBeUndefined();
    controller.dispose();
  });

  test("a model with slow mode on reads On, with the scope omp reports as saved for every chat", async () => {
    const { rpc } = rpcFake({
      state: () =>
        stateWith({ slowModeSupported: true, slowModeEnabled: true, slowModeScope: "global" }),
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    await controller.refresh();
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "known",
      enabled: true,
      requested: true,
      scope: "settings",
      source: "omp-rpc",
    });
    controller.dispose();
  });

  test("a model with slow mode off reads Off, scoped to this chat when omp says so", async () => {
    const { rpc } = rpcFake({
      state: () =>
        stateWith({ slowModeSupported: true, slowModeEnabled: false, slowModeScope: "session" }),
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    await controller.refresh();
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "known",
      enabled: false,
      requested: false,
      scope: "session",
    });
    controller.dispose();
  });

  test("omp's usage-limit stage is kept with the slow mode state, as omp reported it", async () => {
    const usageLimit = { stage: "wrap_up" as const, extraUsage: false, resetsAtSec: 1_791_720_000 };
    const { rpc } = rpcFake({
      state: () =>
        stateWith({
          slowModeSupported: true,
          slowModeEnabled: true,
          slowModeScope: "global",
          usageLimit,
        }),
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    await controller.refresh();
    expect(controller.getSnapshot().modes.slow?.usageLimit).toEqual(usageLimit);
    controller.dispose();
  });

  test("a read that does not say whether slow mode is offered leaves the choice unset", async () => {
    const { rpc } = rpcFake({ state: () => stateWith({}) });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    await controller.refresh();
    expect(controller.getSnapshot().modes.slow).toMatchObject({ state: "fallback" });
    expect(controller.getSnapshot().modes.slow?.requested).toBeUndefined();
    controller.dispose();
  });

  test("when get_state cannot be read, slow mode says the app could not reach omp", async () => {
    const { rpc } = rpcFake({
      state: async () => {
        throw new Error("the connection dropped");
      },
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    await controller.refresh().catch(() => undefined);
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "unavailable",
      reason: "The app could not reach omp. Try again.",
    });
    controller.dispose();
  });
});

describe("changing Slow mode through set_slow_mode", () => {
  test("turning it on sends set_slow_mode, shows omp's answer, and reads the state again", async () => {
    let on = false;
    const { rpc, setCalls, readCount } = rpcFake({
      state: () =>
        stateWith({ slowModeSupported: true, slowModeEnabled: on, slowModeScope: "global" }),
      setSlow: async (enabled) => {
        on = enabled;
        return { enabled };
      },
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    const result = await controller.request({ mode: "slow", scope: "session", requested: true });
    expect(result).toMatchObject({ ok: true, command: "set_slow_mode", state: "known" });
    expect(setCalls).toEqual([true]);
    expect(readCount()).toBe(1);
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "known",
      enabled: true,
      requested: true,
      scope: "settings",
    });
    controller.dispose();
  });

  test("while omp has the change, the choice shows as made", async () => {
    const answer = Promise.withResolvers<{ readonly enabled: boolean }>();
    const { rpc } = rpcFake({
      state: () => stateWith({ slowModeSupported: true, slowModeEnabled: false }),
      setSlow: () => answer.promise,
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    const pending = controller.request({ mode: "slow", scope: "session", requested: true });
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "requested",
      requested: true,
    });
    answer.resolve({ enabled: true });
    await expect(pending).resolves.toMatchObject({ ok: true });
    controller.dispose();
  });
  test("does not assign a scope before omp has reported it, including the reply-refresh gap", async () => {
    const answer = Promise.withResolvers<{ readonly enabled: boolean }>();
    const refresh = Promise.withResolvers<GetStateResult>();
    const refreshStarted = Promise.withResolvers<void>();
    const { rpc } = rpcFake({
      state: () => {
        refreshStarted.resolve();
        return refresh.promise;
      },
      setSlow: () => answer.promise,
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    const pending = controller.request({ mode: "slow", scope: "session", requested: true });

    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "requested",
      requested: true,
      scope: "default",
    });
    answer.resolve({ enabled: true });
    await refreshStarted.promise;
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "known",
      enabled: true,
      scope: "default",
    });

    refresh.resolve(
      stateWith({ slowModeSupported: true, slowModeEnabled: true, slowModeScope: "session" }),
    );
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "known",
      enabled: true,
      scope: "session",
    });
    controller.dispose();
  });

  test("a change omp refuses because the model has no slow mode says so in plain words, and omp's own text is not shown", async () => {
    const { rpc } = rpcFake({
      state: () => stateWith({ slowModeSupported: false, slowModeEnabled: false }),
      setSlow: async () => {
        throw new AppFailure({
          code: "unavailable",
          message: "Slow mode is unavailable for the current model.",
          retryable: false,
        });
      },
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    const result = await controller.request({ mode: "slow", scope: "session", requested: true });
    expect(result).toMatchObject({
      ok: false,
      state: "unavailable",
      error: { code: "unavailable", message: SLOW_UNSUPPORTED_TEXT },
    });
    expect(JSON.stringify(result)).not.toContain("unavailable for the current model");
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "unavailable",
      reason: SLOW_UNSUPPORTED_TEXT,
    });
    controller.dispose();
  });

  test("a change that fails for another reason keeps the value omp last reported, and says omp did not make it", async () => {
    const { rpc } = rpcFake({
      state: () =>
        stateWith({ slowModeSupported: true, slowModeEnabled: false, slowModeScope: "session" }),
      setSlow: async () => {
        throw new Error("the connection dropped");
      },
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    await controller.refresh();
    const result = await controller.request({ mode: "slow", scope: "session", requested: true });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "internal", message: "omp did not make the change. Try again." },
    });
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "known",
      enabled: false,
      requested: false,
    });
    controller.dispose();
  });

  test("a cancelled change says the change was cancelled", async () => {
    const { rpc } = rpcFake({
      state: () => stateWith({ slowModeSupported: true, slowModeEnabled: false }),
      setSlow: async () => {
        throw new AppFailure({ code: "cancelled", message: "aborted", retryable: false });
      },
    });
    const controller = new ModeController({ threadId, capabilities: capabilities(), rpc });
    const result = await controller.request({ mode: "slow", scope: "session", requested: true });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "cancelled", message: "The change was cancelled." },
    });
    controller.dispose();
  });

  test("without the mode RPC, slow mode is not available until the app is connected to omp", async () => {
    const controller = new ModeController({ threadId, capabilities: capabilities() });
    const message = "Slow mode is not available until the app is connected to omp.";
    expect(controller.getSnapshot().modes.slow).toMatchObject({
      state: "unavailable",
      reason: message,
    });
    const result = await controller.request({ mode: "slow", scope: "session", requested: true });
    expect(result).toMatchObject({ ok: false, error: { message } });
    controller.dispose();
  });

  test("a host that does not offer set_slow_mode sends no change, and says slow mode is not available in this chat", async () => {
    const { rpc, setCalls } = rpcFake({});
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "omp.cmd.set_slow_mode": CapabilityStatus.parse({ state: "unavailable", via: "rpc" }),
      }),
      rpc,
    });
    const result = await controller.request({ mode: "slow", scope: "session", requested: true });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Slow mode is not available in this chat." },
    });
    expect(setCalls).toEqual([]);
    controller.dispose();
  });
});
