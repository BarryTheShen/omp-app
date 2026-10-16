import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  CommandRunArgs,
  type CommandRunResult,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  createProviderSetup,
  type ProviderSetupOptions,
  SETUP_CAPABILITIES,
  SETUP_COMMANDS,
  type SetupOutcome,
} from "./setup";

const threadId = ThreadId.parse("d3-setup-thread");
const baseResult: CommandRunResult = {
  command: SETUP_COMMANDS.providers,
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [],
  sessionUpdates: [],
  configUpdates: [],
};

function setup(
  options: {
    gatewayAvailable?: boolean;
    setupAvailable?: boolean;
    fail?: boolean;
    agentInvoked?: boolean;
    status?: "completed" | "aborted";
    wizardAvailable?: boolean;
  } = {},
) {
  const calls: unknown[] = [];
  const client = {
    port: () => ({
      run: async (rawArgs: unknown) => {
        const args = CommandRunArgs.parse(rawArgs);
        calls.push(args);
        if (options.fail)
          throw new AppFailure({ code: "conflict", message: "safe conflict", retryable: true });
        return {
          ...baseResult,
          command: args.command,
          status: options.status ?? "completed",
          agentInvoked: options.agentInvoked ?? false,
        } satisfies CommandRunResult;
      },
    }),
  } as unknown as AppClient;
  const capabilities: CapabilityMap = {
    ...(options.gatewayAvailable === false
      ? {}
      : {
          [SETUP_CAPABILITIES.commandGateway]: {
            state: "available" as const,
            via: "host" as const,
          },
        }),
    ...(options.setupAvailable === false
      ? {}
      : {
          [SETUP_CAPABILITIES.setupCommands]: {
            state: "available" as const,
            via: "upstream" as const,
          },
        }),
    ...(options.wizardAvailable
      ? {
          [SETUP_CAPABILITIES.wizard]: {
            state: "available" as const,
            via: "upstream" as const,
          },
        }
      : {}),
  };
  const openWizard: ProviderSetupOptions["openWizard"] = options.wizardAvailable
    ? async () => ({
        state: "completed",
        command: SETUP_COMMANDS.providers,
        reloadRequired: true,
      })
    : undefined;
  return {
    calls,
    client,
    controller: createProviderSetup({
      client,
      threadId,
      capabilities,
      ...(openWizard ? { openWizard } : {}),
    }),
  };
}

describe("D3 provider setup adapter", () => {
  test("runs only typed setup commands and reports reload required", async () => {
    const { controller, calls } = setup();
    await expect(controller.setupProviders()).resolves.toEqual({
      state: "completed",
      command: SETUP_COMMANDS.providers,
      reloadRequired: true,
    });
    await expect(controller.setup()).resolves.toEqual({
      state: "completed",
      command: SETUP_COMMANDS.setup,
      reloadRequired: true,
    });
    expect(calls).toEqual([
      { threadId, command: SETUP_COMMANDS.providers },
      { threadId, command: SETUP_COMMANDS.setup },
    ]);
  });

  test("does not send either setup command when the gateway is unavailable", async () => {
    const { controller, calls } = setup({ gatewayAvailable: false });
    await expect(controller.setupProviders()).resolves.toMatchObject({
      state: "unavailable",
      error: { appError: { code: "unavailable", capability: SETUP_CAPABILITIES.commandGateway } },
    });
    expect(calls).toEqual([]);
  });

  test("gates terminal-only setup even when the typed command gateway exists", async () => {
    const { controller, calls } = setup({ setupAvailable: false });
    expect(controller.setupCommandsAvailable()).toBe(false);
    await expect(controller.setup()).resolves.toMatchObject({
      state: "unavailable",
      error: {
        appError: {
          capability: SETUP_CAPABILITIES.setupCommands,
          message: "omp can only open provider setup in its terminal.",
        },
      },
    });
    await expect(controller.setupProviders()).resolves.toMatchObject({
      state: "unavailable",
      error: {
        appError: {
          code: "unavailable",
          capability: SETUP_CAPABILITIES.setupCommands,
          message: "omp can only open provider setup in its terminal.",
        },
      },
    });
    expect(calls).toEqual([]);
  });

  test("rejects an agent-invoked result instead of claiming setup finished", async () => {
    const { controller } = setup({ agentInvoked: true });
    await expect(controller.setupProviders()).resolves.toMatchObject({
      state: "error",
      reason: "agent-invoked",
      error: {
        appError: {
          code: "unavailable",
          message: "omp could not open provider setup from here.",
        },
      },
    });
  });

  test("reports aborted setup without a reload outcome", async () => {
    const { controller } = setup({ status: "aborted" });
    await expect(controller.setupProviders()).resolves.toEqual({
      state: "aborted",
      command: SETUP_COMMANDS.providers,
      reloadRequired: false,
    });
  });

  test("maps typed gateway failures without exposing raw output", async () => {
    const { controller } = setup({ fail: true });
    await expect(controller.setupProviders()).resolves.toMatchObject({
      state: "error",
      error: { appError: { code: "conflict", message: "safe conflict" } },
    });
  });

  test("uses an injected wizard only when its capability is available", async () => {
    const wizardOutcome: SetupOutcome = {
      state: "completed",
      command: SETUP_COMMANDS.providers,
      reloadRequired: true,
    };
    const openWizard = vi.fn(async () => wizardOutcome);
    const { client } = setup();
    const controller = createProviderSetup({
      client,
      threadId,
      capabilities: {
        [SETUP_CAPABILITIES.commandGateway]: { state: "available" as const, via: "host" as const },
        [SETUP_CAPABILITIES.setupCommands]: {
          state: "available" as const,
          via: "upstream" as const,
        },
        [SETUP_CAPABILITIES.wizard]: { state: "available" as const, via: "upstream" as const },
      },
      openWizard,
    });
    expect(controller.wizardAvailable()).toBe(true);
    await expect(controller.openWizard()).resolves.toEqual(wizardOutcome);
    expect(openWizard).toHaveBeenCalledOnce();
  });

  test("keeps the wizard unavailable when the capability is absent", async () => {
    const { controller } = setup();
    expect(controller.wizardAvailable()).toBe(false);
    await expect(controller.openWizard()).resolves.toMatchObject({
      state: "unavailable",
      error: {
        appError: {
          code: "unavailable",
          capability: SETUP_CAPABILITIES.wizard,
        },
      },
    });
  });
});
