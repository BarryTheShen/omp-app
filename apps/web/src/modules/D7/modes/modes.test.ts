import {
  AppFailure,
  type CapabilityMap,
  CapabilityStatus,
  type ModeChangeRequest,
  type ModeChangeResult,
  type ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ExecutionMode, ModeCommandGateway, ModeCommandResult } from "../contract";
import { isD73Mode, modeChangeRequest } from "./commands";
import { ModeController } from "./controller";

const threadId = "d7-mode-thread" as ThreadId;

function capabilities(overrides: CapabilityMap = {}): CapabilityMap {
  return {
    "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
    "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "omp" }),
    "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "omp" }),
    ...overrides,
  };
}

/** The typed outcome omp gives a change it made: exactly the value the request asked for. */
function appliedFor(request: ModeChangeRequest): ModeChangeResult {
  return request.mode === "browser"
    ? { outcome: "applied", mode: "browser", visibility: request.visibility }
    : { outcome: "applied", mode: request.mode, on: request.requested };
}

/** The typed outcome omp gives a change it did not make because the mode is not offered here. */
function unsupportedFor(request: ModeChangeRequest): ModeChangeResult {
  return { outcome: "unsupported", mode: request.mode, reason: "not-offered" };
}

/** The typed outcome omp gives a change it tried and did not make. */
function refusedFor(request: ModeChangeRequest): ModeChangeResult {
  return request.mode === "browser"
    ? { outcome: "refused", mode: "browser", reason: "browser-restart-failed" }
    : { outcome: "refused", mode: request.mode, reason: "claude-usage-limit" };
}

describe("D7 mode change requests", () => {
  test("maps each D7 action to the typed request the server takes", () => {
    expect(modeChangeRequest({ mode: "browser", visibility: "headless" })).toEqual({
      mode: "browser",
      visibility: "headless",
    });
    expect(modeChangeRequest({ mode: "computer", requested: true })).toEqual({
      mode: "computer",
      requested: true,
    });
    expect(modeChangeRequest({ mode: "extended-context", requested: false })).toEqual({
      mode: "extended-context",
      requested: false,
    });
  });

  test("does not invent a request for standard execution", () => {
    expect(modeChangeRequest({ mode: "default", requested: true })).toBeNull();
  });

  test("keeps force execution off the D7.3 surface", () => {
    expect(isD73Mode("force")).toBe(false);
  });
});

describe("ModeController", () => {
  test("sends the browser change as a typed request; omp does not report the window, so it reads as set", async () => {
    const requests: ModeChangeRequest[] = [];
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: {
        change: async ({ request }) => {
          requests.push(request);
          return appliedFor(request);
        },
      },
      rpc: {
        setSlowMode: async ({ enabled }) => ({ enabled }),
        getState: async () => ({
          fastModeEnabled: false,
          fastModeActive: false,
          sessionId: "session",
        }),
        setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
      },
    });

    const result = await controller.requestBrowserVisibility("visible");
    expect(result).toMatchObject({
      ok: true,
      command: "/browser visible",
      mode: "browser",
      state: "fallback",
    });
    expect(requests).toEqual([{ mode: "browser", visibility: "visible" }]);
    expect(controller.getBrowserVisibility()).toBe("visible");
    expect(controller.getSnapshot().modes.browser).toMatchObject({
      state: "fallback",
      requested: true,
    });
    controller.dispose();
  });

  test("keeps fast enabled and provider-active values separate", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      rpc: {
        setSlowMode: async ({ enabled }) => ({ enabled }),
        getState: async () => ({
          fastModeEnabled: true,
          fastModeActive: false,
          sessionId: "session",
        }),
        setFastMode: async () => ({ enabled: true, active: false }),
      },
    });

    const result = await controller.request({ mode: "fast", scope: "session", requested: true });
    expect(result).toMatchObject({ ok: true, state: "known" });
    expect(controller.getSnapshot().fast).toMatchObject({
      enabled: true,
      active: false,
      state: "known",
    });
    await controller.refresh();
    expect(controller.getSnapshot().fast.active).toBe(false);
    controller.dispose();
  });

  test("does not call a missing command capability and reports a visible reason", async () => {
    let called = false;
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "host.command-gateway": CapabilityStatus.parse({
          state: "unavailable",
          via: "host",
          detail: "The command service is offline.",
        }),
      }),
      gateway: {
        change: async ({ request }) => {
          called = true;
          return appliedFor(request);
        },
      },
    });

    const result = await controller.request({
      mode: "computer",
      scope: "session",
      requested: true,
    });
    expect(result).toMatchObject({
      ok: false,
      state: "unavailable",
      capability: "host.command-gateway",
    });
    expect(called).toBe(false);
    expect(result.reason).toBe("These settings are not available in this chat.");
    controller.dispose();
  });

  test("an unknown reply is shown as omp wrote it, and the change is not claimed as applied", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: answering("unknown"),
    });

    const result = await controller.request({
      mode: "computer",
      scope: "session",
      requested: true,
    });
    expect(result).toMatchObject({
      ok: true,
      command: "/computer on",
      state: "requested",
      reason: "This output is opaque to the mode controller.",
    });
    const computer = controller.getSnapshot().modes.computer;
    expect(computer).toMatchObject({ state: "requested", requested: true });
    expect(computer?.enabled).toBeUndefined();
    expect(computer?.active).toBeUndefined();
    controller.dispose();
  });

  test("a refused browser change puts the window back and says it can be tried again", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: answering("applied", "refused"),
    });
    await controller.requestBrowserVisibility("visible");

    const result = await controller.requestBrowserVisibility("headless");
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "The browser could not restart in that window. Try again.",
        retryable: true,
      },
    });
    expect(controller.getBrowserVisibility()).toBe("visible");
    controller.dispose();
  });

  test("a browser change that does not run puts the window back", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: answering("cancelled"),
    });

    const result = await controller.requestBrowserVisibility("visible");
    expect(result).toMatchObject({ ok: false, state: "unavailable" });
    expect(controller.getBrowserVisibility()).toBeNull();
    controller.dispose();
  });
});

describe("a mode omp does not report", () => {
  test("starts with no choice recorded, so neither button is set", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: answering("applied"),
    });
    const computer = controller.getSnapshot().modes.computer;
    expect(computer?.state).toBe("fallback");
    expect(computer?.requested).toBeUndefined();
    expect(computer?.enabled).toBeUndefined();
    controller.dispose();
  });

  test("a failed Fast change keeps the value omp last reported and stays enabled", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      rpc: {
        setSlowMode: async ({ enabled }) => ({ enabled }),
        getState: async () => ({
          fastModeEnabled: false,
          fastModeActive: false,
          sessionId: "session",
        }),
        setFastMode: async () => {
          throw new Error("omp did not answer the Fast mode change.");
        },
      },
    });
    await controller.refresh();

    const result = await controller.request({ mode: "fast", scope: "session", requested: true });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "The app could not reach omp. Try again.", retryable: true },
    });
    expect(controller.getSnapshot().fast).toMatchObject({ enabled: false, state: "known" });
    expect(controller.getSnapshot().fast.requested).toBeUndefined();
    controller.dispose();
  });

  test("a Fast change omp refuses tells the surface once, so omp's notice about it can be let go", async () => {
    let refusals = 0;
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      rpc: {
        getState: async () => ({
          fastModeEnabled: false,
          fastModeActive: false,
          sessionId: "session",
        }),
        setFastMode: async () => {
          throw new AppFailure({
            code: "omp_error",
            message: "Fast mode is unavailable for the current model.",
            retryable: false,
          });
        },
        setSlowMode: async () => {
          throw new Error("This test does not change Slow mode.");
        },
      },
      onFastRefused: () => {
        refusals += 1;
      },
    });
    await controller.refresh();

    await controller.request({ mode: "fast", scope: "session", requested: true });
    expect(refusals).toBe(1);
    controller.dispose();
  });

  test("a failed Fast change before omp has reported anything reports nothing", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      rpc: {
        setSlowMode: async ({ enabled }) => ({ enabled }),
        getState: () => Promise.withResolvers<never>().promise,
        setFastMode: async () => {
          throw new Error("omp did not answer the Fast mode change.");
        },
      },
    });

    const result = await controller.request({ mode: "fast", scope: "session", requested: true });
    expect(result).toMatchObject({ ok: false });
    expect(controller.getSnapshot().fast).toMatchObject({ state: "fallback" });
    expect(controller.getSnapshot().fast.requested).toBeUndefined();
    controller.dispose();
  });

  test("a Fast change waiting on omp shows the requested value over the last value omp reported", async () => {
    const answer = Promise.withResolvers<{ enabled: boolean; active: boolean }>();
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      rpc: {
        setSlowMode: async ({ enabled }) => ({ enabled }),
        getState: async () => ({
          fastModeEnabled: false,
          fastModeActive: false,
          sessionId: "session",
        }),
        setFastMode: () => answer.promise,
      },
    });
    await controller.refresh();

    const pending = controller.request({ mode: "fast", scope: "session", requested: true });
    expect(controller.getSnapshot().fast).toMatchObject({
      enabled: false,
      state: "requested",
      requested: true,
    });
    answer.resolve({ enabled: true, active: true });
    expect(await pending).toMatchObject({ ok: true });
    expect(controller.getSnapshot().fast).toMatchObject({ enabled: true, state: "known" });
    expect(controller.getSnapshot().fast.requested).toBeUndefined();
    controller.dispose();
  });
});

/** What the gateway does with one command: applies it, refuses it, says it is unsupported, replies unknown, cancels or fails. */
type Outcome = "applied" | "refused" | "unsupported" | "unknown" | "cancelled" | "failed";

/** A gateway that answers the changes it is sent, one outcome each, in order. */
function answering(...outcomes: readonly Outcome[]): ModeCommandGateway {
  const queue = [...outcomes];
  return {
    change: async ({ request }) => {
      const outcome = queue.shift();
      if (outcome === undefined || outcome === "failed") {
        throw new Error("omp did not answer the execution-mode command.");
      }
      if (outcome === "cancelled") {
        throw new AppFailure({
          code: "cancelled",
          message: "The command was cancelled.",
          retryable: false,
        });
      }
      if (outcome === "unsupported") return unsupportedFor(request);
      if (outcome === "refused") return refusedFor(request);
      if (outcome === "unknown") {
        return {
          outcome: "unknown",
          mode: request.mode,
          outputs: ["This output is opaque to the mode controller."],
        };
      }
      return appliedFor(request);
    },
  };
}

/** One mode's change: asked as on or off, what its buttons show as chosen, and the state omp's acceptance leaves. */
interface ModeChange {
  readonly mode: ExecutionMode;
  readonly change: (controller: ModeController, on: boolean) => Promise<ModeCommandResult>;
  readonly chosen: (controller: ModeController) => boolean | undefined;
  /** The state a change omp applied is kept in: omp's known value for a toggle, a set window for the browser. */
  readonly applied: "known" | "fallback";
}

/** The four modes whose change the view offers as buttons; browser use chooses visible or headless. */
const MODE_CHANGES: readonly ModeChange[] = [
  {
    mode: "computer",
    change: (controller, on) =>
      controller.request({ mode: "computer", scope: "session", requested: on }),
    chosen: (controller) => controller.getSnapshot().modes.computer?.requested,
    applied: "known",
  },
  {
    mode: "extended-context",
    change: (controller, on) =>
      controller.request({ mode: "extended-context", scope: "session", requested: on }),
    chosen: (controller) => controller.getSnapshot().modes["extended-context"]?.requested,
    applied: "known",
  },
  {
    mode: "browser",
    change: (controller, on) => controller.requestBrowserVisibility(on ? "visible" : "headless"),
    chosen: (controller) => {
      const visibility = controller.getBrowserVisibility();
      return visibility === null ? undefined : visibility === "visible";
    },
    applied: "fallback",
  },
];

describe.each(MODE_CHANGES)(
  "a change to $mode that omp does not complete",
  ({ mode, change, chosen, applied }) => {
    test("before omp has reported a value: neither choice is set, the mode stays enabled, and a later change works", async () => {
      const controller = new ModeController({
        threadId,
        capabilities: capabilities(),
        gateway: answering("failed", "applied"),
      });
      const failed = await change(controller, true);
      expect(failed).toMatchObject({
        ok: false,
        error: { message: "The app could not reach omp. Try again." },
      });
      expect(chosen(controller)).toBeUndefined();
      expect(controller.getSnapshot().modes[mode]?.state).toBe("fallback");

      expect(await change(controller, true)).toMatchObject({ ok: true });
      expect(chosen(controller)).toBe(true);
      controller.dispose();
    });

    test("keeps the value omp last accepted when a later change fails", async () => {
      const controller = new ModeController({
        threadId,
        capabilities: capabilities(),
        gateway: answering("applied", "failed"),
      });
      expect(await change(controller, true)).toMatchObject({ ok: true });
      expect(await change(controller, false)).toMatchObject({ ok: false });
      expect(chosen(controller)).toBe(true);
      expect(controller.getSnapshot().modes[mode]?.state).toBe(applied);
      controller.dispose();
    });

    test("keeps the value omp last accepted when a later change is cancelled", async () => {
      const controller = new ModeController({
        threadId,
        capabilities: capabilities(),
        gateway: answering("applied", "cancelled"),
      });
      expect(await change(controller, true)).toMatchObject({ ok: true });
      expect(await change(controller, false)).toMatchObject({
        ok: false,
        error: { code: "cancelled" },
      });
      expect(chosen(controller)).toBe(true);
      expect(controller.getSnapshot().modes[mode]?.state).toBe(applied);
      controller.dispose();
    });

    test("keeps the value omp last accepted when a later change is refused or unsupported", async () => {
      const controller = new ModeController({
        threadId,
        capabilities: capabilities(),
        gateway: answering("applied", "refused", "unsupported"),
      });
      expect(await change(controller, true)).toMatchObject({ ok: true });
      expect(await change(controller, false)).toMatchObject({ ok: false });
      expect(await change(controller, false)).toMatchObject({ ok: false });
      expect(chosen(controller)).toBe(true);
      expect(controller.getSnapshot().modes[mode]?.state).toBe(applied);
      controller.dispose();
    });

    test("cancelled before omp has reported a value: neither choice is set and the mode stays enabled", async () => {
      const controller = new ModeController({
        threadId,
        capabilities: capabilities(),
        gateway: answering("cancelled"),
      });
      expect(await change(controller, true)).toMatchObject({
        ok: false,
        error: { code: "cancelled" },
      });
      expect(chosen(controller)).toBeUndefined();
      expect(controller.getSnapshot().modes[mode]?.state).toBe("fallback");
      controller.dispose();
    });
  },
);
