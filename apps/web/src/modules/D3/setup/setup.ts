import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityKey,
  type CapabilityMap,
  type CommandRunResult,
  OmpCommandGateway,
  type ThreadId,
} from "@omp-app/contracts";

export const SETUP_COMMANDS = {
  setup: "/setup",
  providers: "/setup providers",
} as const;

export const SETUP_CAPABILITIES = {
  commandGateway: "host.command-gateway" as CapabilityKey,
  setupCommands: "upstream.provider-setup-commands" as CapabilityKey,
  wizard: "upstream.setup-wizard" as CapabilityKey,
} as const;

export type SetupCommand = (typeof SETUP_COMMANDS)[keyof typeof SETUP_COMMANDS];
export type SetupOutcome =
  | { readonly state: "completed"; readonly command: SetupCommand; readonly reloadRequired: true }
  | { readonly state: "aborted"; readonly command: SetupCommand; readonly reloadRequired: false }
  | { readonly state: "unavailable"; readonly command: SetupCommand; readonly error: AppFailure }
  | {
      readonly state: "error";
      readonly command: SetupCommand;
      readonly error: AppFailure;
      readonly reason?: "agent-invoked";
    };

export interface ProviderSetupOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities: CapabilityMap;
  readonly openWizard?: (options?: { readonly signal?: AbortSignal }) => Promise<SetupOutcome>;
}

export interface ProviderSetupController {
  readonly capabilities: () => CapabilityMap;
  readonly run: (
    command: SetupCommand,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<SetupOutcome>;
  readonly setup: (options?: { readonly signal?: AbortSignal }) => Promise<SetupOutcome>;
  readonly setupProviders: (options?: { readonly signal?: AbortSignal }) => Promise<SetupOutcome>;
  readonly wizardAvailable: () => boolean;
  readonly setupCommandsAvailable: () => boolean;
  readonly openWizard: (options?: { readonly signal?: AbortSignal }) => Promise<SetupOutcome>;
}

function failure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure({ code: "internal", message: fallback, retryable: false });
}

function unavailable(
  capability: CapabilityKey,
  command: SetupCommand,
  message: string,
): SetupOutcome {
  return {
    state: "unavailable",
    command,
    error: new AppFailure({
      code: "unavailable",
      message,
      retryable: false,
      capability,
    }),
  };
}

function wizardUnavailable(): SetupOutcome {
  return {
    state: "unavailable",
    command: SETUP_COMMANDS.providers,
    error: new AppFailure({
      code: "unavailable",
      message: "omp only offers the setup wizard in its terminal.",
      retryable: false,
      capability: SETUP_CAPABILITIES.wizard,
    }),
  };
}

function completed(command: SetupCommand, result: CommandRunResult): SetupOutcome {
  if (result.agentInvoked) {
    return {
      state: "error",
      command,
      reason: "agent-invoked",
      error: new AppFailure({
        code: "unavailable",
        message: "omp could not open provider setup from here.",
        retryable: false,
        capability: SETUP_CAPABILITIES.setupCommands,
      }),
    };
  }
  if (result.status === "aborted") return { state: "aborted", command, reloadRequired: false };
  return { state: "completed", command, reloadRequired: true };
}

/** Runs allow-listed setup commands through A1's typed gateway; output prose never reaches the browser. */
export function createProviderSetup(options: ProviderSetupOptions): ProviderSetupController {
  const gateway = options.client.port(OmpCommandGateway);
  const capabilities = options.capabilities;
  const gatewayAvailable = capabilities[SETUP_CAPABILITIES.commandGateway]?.state === "available";
  const setupCommandsAvailable =
    capabilities[SETUP_CAPABILITIES.setupCommands]?.state === "available";
  const canWizard =
    capabilities[SETUP_CAPABILITIES.wizard]?.state === "available" &&
    options.openWizard !== undefined;

  const run = async (
    command: SetupCommand,
    callOptions?: { readonly signal?: AbortSignal },
  ): Promise<SetupOutcome> => {
    if (!gatewayAvailable) {
      return unavailable(
        SETUP_CAPABILITIES.commandGateway,
        command,
        "Provider setup is unavailable for this session.",
      );
    }
    if (!setupCommandsAvailable) {
      return unavailable(
        SETUP_CAPABILITIES.setupCommands,
        command,
        "omp can only open provider setup in its terminal.",
      );
    }
    try {
      const result = await gateway.run({ threadId: options.threadId, command }, callOptions);
      return completed(command, result);
    } catch (error) {
      return {
        state: "error",
        command,
        error: failure(error, "Provider setup failed. Try again."),
      };
    }
  };
  const openWizard = async (callOptions?: {
    readonly signal?: AbortSignal;
  }): Promise<SetupOutcome> => {
    if (!canWizard || !options.openWizard) return wizardUnavailable();
    try {
      return await options.openWizard(callOptions);
    } catch (error) {
      return {
        state: "error",
        command: SETUP_COMMANDS.providers,
        error: failure(error, "Provider setup wizard failed. Try again."),
      };
    }
  };

  return {
    capabilities: () => capabilities,
    run,
    setup: (callOptions) => run(SETUP_COMMANDS.setup, callOptions),
    setupProviders: (callOptions) => run(SETUP_COMMANDS.providers, callOptions),
    wizardAvailable: () => canWizard,
    setupCommandsAvailable: () => setupCommandsAvailable,
    openWizard,
  };
}
