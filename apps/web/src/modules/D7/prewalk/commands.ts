import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CommandRunResult,
  OmpCommandGateway,
  type PortCallOptions,
  type ThreadId,
} from "@omp-app/contracts";

export type D74Command =
  | "/prewalk"
  | "/prewalk restart"
  | "/prewalk off"
  | "/shake elide"
  | "/shake images"
  | "/shake thinking"
  | "/skillful on"
  | "/skillful off"
  | "/skillful status"
  | "/skillful toggle"
  | "/tools";

export interface D74CommandClient {
  readonly run: (
    threadId: ThreadId,
    command: D74Command,
    options?: PortCallOptions,
  ) => Promise<CommandRunResult>;
}

/** A1's typed command gateway adapter. The browser passes structured results through unchanged. */
export function createD74CommandClient(client: Pick<AppClient, "port">): D74CommandClient {
  const gateway = client.port(OmpCommandGateway);
  return {
    run: (threadId, command, options) => gateway.run({ threadId, command }, options),
  };
}

export interface D74CommandSurface {
  readonly state:
    | "idle"
    | "confirming"
    | "requested"
    | "complete"
    | "unknown"
    | "error"
    | "unavailable";
  readonly command?: D74Command;
  readonly result?: CommandRunResult;
  readonly message?: string;
}
export const RECONNECT_FALLBACK_MESSAGE =
  "The app reconnected, but omp has not confirmed this state yet.";

export function idleCommandSurface(): D74CommandSurface {
  return { state: "idle" };
}

export function unknownAfterReconnect(command?: D74Command): D74CommandSurface {
  return { state: "unknown", command, message: RECONNECT_FALLBACK_MESSAGE };
}

export async function runD74Command(
  client: D74CommandClient,
  threadId: ThreadId,
  command: D74Command,
  options?: PortCallOptions,
): Promise<D74CommandSurface> {
  try {
    const result = await client.run(threadId, command, options);
    if (result.agentInvoked) {
      return { state: "error", command, result, message: "omp did not recognise this command." };
    }
    if (result.status === "aborted") {
      return {
        state: "error",
        command,
        result,
        message: "omp stopped before it finished this command.",
      };
    }
    return { state: "complete", command, result };
  } catch (error) {
    return {
      state: "error",
      command,
      message:
        error instanceof AppFailure
          ? error.appError.message
          : "The app could not reach omp. Try again.",
    };
  }
}
