import {
  type CapabilityMap,
  CapabilityStatus,
  type CommandRunResult,
  type ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ExecutionMode, ModeCommandGateway, ModeCommandResult } from "../contract";
import { isD73Mode, modeCommand } from "./commands";
import { ModeController } from "./controller";

const threadId = "d7-mode-thread" as ThreadId;

function capabilities(overrides: CapabilityMap = {}): CapabilityMap {
  return {
    "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
    "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    ...overrides,
  };
}

function commandResult(
  command: string,
  status: "completed" | "aborted" = "completed",
): CommandRunResult {
  return {
    command: command as CommandRunResult["command"],
    status,
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: [{ text: "This output is opaque to the mode controller." }],
    sessionUpdates: [],
    configUpdates: [],
  };
}

describe("D7 mode command grammar", () => {
  test("uses omp's exact browser and toggle command spellings", () => {
    expect(modeCommand({ mode: "browser", visibility: "headless" })).toBe("/browser headless");
    expect(modeCommand({ mode: "browser", visibility: "visible" })).toBe("/browser visible");
    expect(modeCommand({ mode: "computer", requested: true })).toBe("/computer on");
    expect(modeCommand({ mode: "extended-context", requested: false })).toBe(
      "/extended-context off",
    );
    expect(modeCommand({ mode: "slow", requested: true })).toBe("/slow on");
  });

  test("does not invent a slash command for standard execution", () => {
    expect(modeCommand({ mode: "default", requested: true })).toBeNull();
  });

  test("keeps force execution off the D7.3 surface", () => {
    expect(isD73Mode("force")).toBe(false);
  });
});

describe("ModeController", () => {
  test("sends browser commands through the typed gateway; omp's reply is shown, not read as state", async () => {
    const commands: string[] = [];
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: {
        run: async ({ command }) => {
          commands.push(command);
          return commandResult(command);
        },
      },
      fastRpc: {
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
      state: "requested",
    });
    expect(commands).toEqual(["/browser visible"]);
    expect(controller.getBrowserVisibility()).toBe("visible");
    expect(controller.getSnapshot().modes.browser).toMatchObject({
      state: "requested",
      requested: true,
    });
    controller.dispose();
  });

  test("keeps fast enabled and provider-active values separate", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      fastRpc: {
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
        run: async ({ command }) => {
          called = true;
          return commandResult(command);
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
    expect(result.reason).toBe("The command service is offline.");
    controller.dispose();
  });

  test("turns an aborted command into a typed cancelled result and keeps the mode enabled", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: { run: async ({ command }) => commandResult(command, "aborted") },
    });
    const result = await controller.request({ mode: "slow", scope: "session", requested: true });
    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(controller.getSnapshot().modes.slow).toMatchObject({ state: "fallback" });
    controller.dispose();
  });

  test("records a completed command as requested, shows omp's reply, and claims no enabled state", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: {
        run: async ({ command }) => ({
          ...commandResult(command),
          outputs: [{ text: "Computer use is unavailable in this session." }],
        }),
      },
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
      reason: "Computer use is unavailable in this session.",
    });
    const computer = controller.getSnapshot().modes.computer;
    expect(computer).toMatchObject({ state: "requested", requested: true });
    expect(computer?.enabled).toBeUndefined();
    expect(computer?.active).toBeUndefined();
    controller.dispose();
  });

  test("puts the browser visibility back when the command does not run", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: {
        run: async ({ command }) => commandResult(command, "aborted"),
      },
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
      gateway: { run: async ({ command }) => commandResult(command) },
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
      fastRpc: {
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
      error: { message: "Fast mode could not be changed.", retryable: true },
    });
    expect(controller.getSnapshot().fast).toMatchObject({ enabled: false, state: "known" });
    expect(controller.getSnapshot().fast.requested).toBeUndefined();
    controller.dispose();
  });

  test("a failed Fast change before omp has reported anything reports nothing", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      fastRpc: {
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
      fastRpc: {
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

/** What the gateway does with one command: it completes it, cancels it (aborted) or fails it (throws). */
type Outcome = "completed" | "cancelled" | "failed";

/** A gateway that answers the commands it is sent, one outcome each, in order. */
function answering(...outcomes: readonly Outcome[]): ModeCommandGateway {
  const queue = [...outcomes];
  return {
    run: async ({ command }) => {
      const outcome = queue.shift();
      if (outcome === undefined || outcome === "failed") {
        throw new Error("omp did not answer the execution-mode command.");
      }
      return commandResult(command, outcome === "cancelled" ? "aborted" : "completed");
    },
  };
}

/** One mode's change: asked as on or off, and what its buttons show as chosen (undefined: neither). */
interface ModeChange {
  readonly mode: ExecutionMode;
  readonly change: (controller: ModeController, on: boolean) => Promise<ModeCommandResult>;
  readonly chosen: (controller: ModeController) => boolean | undefined;
}

/** The four modes whose change the view offers as buttons; browser use chooses visible or headless. */
const MODE_CHANGES: readonly ModeChange[] = [
  {
    mode: "computer",
    change: (controller, on) =>
      controller.request({ mode: "computer", scope: "session", requested: on }),
    chosen: (controller) => controller.getSnapshot().modes.computer?.requested,
  },
  {
    mode: "extended-context",
    change: (controller, on) =>
      controller.request({ mode: "extended-context", scope: "session", requested: on }),
    chosen: (controller) => controller.getSnapshot().modes["extended-context"]?.requested,
  },
  {
    mode: "slow",
    change: (controller, on) =>
      controller.request({ mode: "slow", scope: "session", requested: on }),
    chosen: (controller) => controller.getSnapshot().modes.slow?.requested,
  },
  {
    mode: "browser",
    change: (controller, on) => controller.requestBrowserVisibility(on ? "visible" : "headless"),
    chosen: (controller) => {
      const visibility = controller.getBrowserVisibility();
      return visibility === null ? undefined : visibility === "visible";
    },
  },
];

describe.each(MODE_CHANGES)(
  "a change to $mode that omp does not complete",
  ({ mode, change, chosen }) => {
    test("before omp has reported a value: neither choice is set, the mode stays enabled, and a later change works", async () => {
      const controller = new ModeController({
        threadId,
        capabilities: capabilities(),
        gateway: answering("failed", "completed"),
      });
      const failed = await change(controller, true);
      expect(failed).toMatchObject({
        ok: false,
        error: { message: "The execution-mode command could not finish." },
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
        gateway: answering("completed", "failed"),
      });
      expect(await change(controller, true)).toMatchObject({ ok: true });
      expect(await change(controller, false)).toMatchObject({ ok: false });
      expect(chosen(controller)).toBe(true);
      expect(controller.getSnapshot().modes[mode]?.state).toBe("requested");
      controller.dispose();
    });

    test("keeps the value omp last accepted when a later change is cancelled", async () => {
      const controller = new ModeController({
        threadId,
        capabilities: capabilities(),
        gateway: answering("completed", "cancelled"),
      });
      expect(await change(controller, true)).toMatchObject({ ok: true });
      expect(await change(controller, false)).toMatchObject({
        ok: false,
        error: { code: "cancelled" },
      });
      expect(chosen(controller)).toBe(true);
      expect(controller.getSnapshot().modes[mode]?.state).toBe("requested");
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
