import {
  type CapabilityMap,
  CapabilityStatus,
  type CommandRunResult,
  type ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { D7_AP6_REASON, toolAvailability, unavailableMode } from "../contract";
import { ModeController } from "./controller";

const threadId = "d7-wording-thread" as ThreadId;

function capabilities(overrides: CapabilityMap = {}): CapabilityMap {
  return {
    "host.command-gateway": CapabilityStatus.parse({ state: "available", via: "host" }),
    "omp.cmd.get_state": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "available", via: "rpc" }),
    ...overrides,
  };
}

/** A completed command; `text` is the reply omp gave, when it gave one. */
function completed(command: string, text?: string): CommandRunResult {
  return {
    command: command as CommandRunResult["command"],
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: text === undefined ? [] : [{ text }],
    sessionUpdates: [],
    configUpdates: [],
  };
}

const fastState = { sessionId: "session", fastModeEnabled: false, fastModeActive: false };

describe("plain reasons for Fast mode", () => {
  test("says Fast mode waits for the app to connect to omp when there is no session connection", () => {
    const controller = new ModeController({ threadId, capabilities: capabilities() });
    expect(controller.getSnapshot().fast.reason).toBe(
      "Fast mode is not available until the app is connected to omp.",
    );
    controller.dispose();
  });

  test("says Fast mode is not available in this chat when omp's Fast mode command is missing", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "unavailable", via: "rpc" }),
      }),
      fastRpc: {
        getState: async () => fastState,
        setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
      },
    });
    expect(controller.getSnapshot().fast.reason).toBe("Fast mode is not available in this chat.");
    controller.dispose();
  });

  test("keeps the server's own detail for a missing command out of the Fast mode row", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "omp.cmd.set_fast_mode": CapabilityStatus.parse({
          state: "unavailable",
          via: "rpc",
          detail: "Unknown command: set_fast_mode (omp-v18.6.1:docs/rpc.md:141-149)",
        }),
      }),
      fastRpc: {
        getState: async () => fastState,
        setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
      },
    });
    const reason = controller.getSnapshot().fast.reason;
    expect(reason).toBe("Fast mode is not available in this chat.");
    expect(reason).not.toContain("Unknown command");
    controller.dispose();
  });

  test("says Fast mode is not available in this chat when a change is asked for and the command is missing", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "omp.cmd.set_fast_mode": CapabilityStatus.parse({ state: "unavailable", via: "rpc" }),
      }),
      fastRpc: {
        getState: async () => fastState,
        setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
      },
    });
    const result = await controller.request({ mode: "fast", scope: "session", requested: true });
    expect(result.reason).toBe("Fast mode is not available in this chat.");
    controller.dispose();
  });

  test("says omp did not say whether Fast mode is on when its answer leaves that out", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      fastRpc: {
        getState: async () => ({ sessionId: "session" }),
        setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
      },
    });
    await controller.refresh();
    expect(controller.getSnapshot().fast.reason).toBe("omp did not say whether Fast mode is on.");
    controller.dispose();
  });

  test("says the app could not reach omp when reading the settings fails with a plain error", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      fastRpc: {
        getState: async () => {
          throw new Error("the connection dropped");
        },
        setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
      },
    });
    const failure = await controller.refresh().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      appError: { message: "The app could not reach omp. Try again." },
    });
    controller.dispose();
  });

  test("says omp cannot report these settings in this chat when reading them is not offered", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "omp.cmd.get_state": CapabilityStatus.parse({ state: "unavailable", via: "rpc" }),
      }),
      fastRpc: {
        getState: async () => fastState,
        setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
      },
    });
    const failure = await controller.refresh().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      appError: { message: "omp cannot report these settings in this chat." },
    });
    controller.dispose();
  });

  test("keeps the server's own detail for an unknown command out of the failure message", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "omp.cmd.get_state": CapabilityStatus.parse({
          state: "unavailable",
          via: "rpc",
          detail: "Unknown command: get_state (omp-v18.6.1:docs/rpc.md:141-149)",
        }),
      }),
      fastRpc: {
        getState: async () => fastState,
        setFastMode: async ({ enabled }) => ({ enabled, active: enabled }),
      },
    });
    const failure = await controller.refresh().catch((error: unknown) => error);
    expect(JSON.stringify(failure)).not.toContain("Unknown command");
    controller.dispose();
  });
});

describe("plain reasons for the other modes", () => {
  test("says omp has not reported this setting yet when the mode has no value from omp", () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: { run: async ({ command }) => completed(command) },
    });
    expect(controller.getSnapshot().modes.computer?.reason).toBe(
      "omp has not reported this setting yet.",
    );
    controller.dispose();
  });

  test("says these settings are not available here when no chat is connected to them", () => {
    const controller = new ModeController({ threadId, capabilities: capabilities() });
    expect(controller.getSnapshot().modes.computer?.reason).toBe(
      "These settings are not available here.",
    );
    controller.dispose();
  });

  test("says these settings are not available until the app connects to omp when a change is asked for without a gateway", async () => {
    const controller = new ModeController({ threadId, capabilities: capabilities() });
    const result = await controller.request({
      mode: "computer",
      scope: "session",
      requested: true,
    });
    expect(result.reason).toBe(
      "These settings are not available until the app is connected to omp.",
    );
    controller.dispose();
  });

  test("says these settings are not available in this chat when the gateway is unavailable", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "host.command-gateway": CapabilityStatus.parse({ state: "unavailable", via: "host" }),
      }),
      gateway: { run: async ({ command }) => completed(command) },
    });
    const result = await controller.request({
      mode: "computer",
      scope: "session",
      requested: true,
    });
    expect(result.reason).toBe("These settings are not available in this chat.");
    controller.dispose();
  });

  test("keeps the server's own detail for an unavailable gateway out of the row", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "host.command-gateway": CapabilityStatus.parse({
          state: "unavailable",
          via: "host",
          detail: "omp did not return a command response before the probe timed out",
        }),
      }),
      gateway: { run: async ({ command }) => completed(command) },
    });
    const result = await controller.request({
      mode: "computer",
      scope: "session",
      requested: true,
    });
    expect(result.reason).toBe("These settings are not available in this chat.");
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("probe");
    controller.dispose();
  });

  test("says the app can only partly change these settings when its gateway is limited", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities({
        "host.command-gateway": CapabilityStatus.parse({ state: "fallback", via: "host" }),
      }),
      gateway: { run: async ({ command }) => completed(command) },
    });
    const result = await controller.request({
      mode: "computer",
      scope: "session",
      requested: true,
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.reason).toBe("The app can only partly change these settings right now.");
    controller.dispose();
  });

  test("keeps omp's own reply exactly as omp wrote it", async () => {
    const reply = "Slow mode on: requests use the flex tier (lower cost, higher latency).";
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: { run: async ({ command }) => completed(command, reply) },
    });
    const result = await controller.request({ mode: "slow", scope: "session", requested: true });
    expect(result.reason).toBe(reply);
    expect(controller.getSnapshot().modes.slow?.reason).toBe(reply);
    controller.dispose();
  });

  test("says the change was cancelled when omp does not finish it", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: {
        run: async ({ command }) => ({ ...completed(command), status: "aborted" as const }),
      },
    });
    const result = await controller.request({ mode: "slow", scope: "session", requested: true });
    expect(result.error?.message).toBe("The change was cancelled.");
    controller.dispose();
  });

  test("says the app could not reach omp when the command fails", async () => {
    const controller = new ModeController({
      threadId,
      capabilities: capabilities(),
      gateway: {
        run: async () => {
          throw new Error("the connection dropped");
        },
      },
    });
    const result = await controller.request({ mode: "slow", scope: "session", requested: true });
    expect(result.error?.message).toBe("The app could not reach omp. Try again.");
    controller.dispose();
  });

  test("says force execution applies only to omp's next reply", async () => {
    const controller = new ModeController({ threadId, capabilities: capabilities() });
    const result = await controller.request({ mode: "force", scope: "session", requested: true });
    expect(result.reason).toBe(
      "Force execution applies only to omp's next reply, so this dialog does not offer it.",
    );
    controller.dispose();
  });

  test("says a setting handled elsewhere is changed somewhere else in the app", async () => {
    const controller = new ModeController({ threadId, capabilities: capabilities() });
    const result = await controller.request({ mode: "prewalk", scope: "session", requested: true });
    expect(result.reason).toBe("This setting is changed somewhere else in the app.");
    controller.dispose();
  });

  test("says standard execution is always on, so there is nothing to change", async () => {
    const controller = new ModeController({ threadId, capabilities: capabilities() });
    const result = await controller.request({ mode: "default", scope: "session", requested: true });
    expect(result.reason).toBe("Standard execution is always on, so there is nothing to change.");
    controller.dispose();
  });
});

describe("plain reasons from the contract", () => {
  test("says the app cannot read an extended-context setting from omp yet", () => {
    const state = unavailableMode("extended-context", "session", "omp-command");
    expect(state.reason).toBe("The app cannot read this setting from omp yet.");
    expect(D7_AP6_REASON).toBe("The app cannot read this setting from omp yet.");
  });

  test("says a setting is not available when no reason is given", () => {
    expect(unavailableMode("slow", "session", "omp-command").reason).toBe(
      "This setting is not available.",
    );
  });

  test("says the app can only partly provide a tool when its capability is limited", () => {
    const availability = toolAvailability(
      "bash",
      capabilities({
        "host.command-gateway": CapabilityStatus.parse({ state: "fallback", via: "host" }),
      }),
      { capability: "host.command-gateway" },
    );
    expect(availability.reason).toBe("The app can only partly provide this tool.");
  });

  test("says a tool is not available here when its capability is missing", () => {
    const availability = toolAvailability(
      "bash",
      capabilities({
        "host.command-gateway": CapabilityStatus.parse({ state: "unavailable", via: "host" }),
      }),
      { capability: "host.command-gateway" },
    );
    expect(availability.reason).toBe("This tool is not available here.");
  });
});
