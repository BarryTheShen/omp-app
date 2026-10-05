import type { AppClient } from "@omp-app/client";
import type { PortCallOptions, ThreadId } from "@omp-app/contracts";
import {
  AppFailure,
  type CommandRunResult,
  OmpCommandGateway,
  SlashCommand,
} from "@omp-app/contracts";

export interface TodoCommandGateway {
  readonly run: (
    args: { readonly threadId: ThreadId; readonly command: SlashCommand },
    options?: PortCallOptions,
  ) => Promise<CommandRunResult>;
}

/** Binds U5's explicit `/todo` command surface to A1.8; U5 never parses command prose. */
export function createTodoCommandGateway(client: AppClient): TodoCommandGateway {
  const port = client.port(OmpCommandGateway);
  return { run: (args, options) => port.run(args, options) };
}

export async function runTodoCommand(
  gateway: TodoCommandGateway,
  threadId: ThreadId,
  command: string,
  options?: PortCallOptions,
): Promise<CommandRunResult> {
  let slashCommand: SlashCommand;
  try {
    slashCommand = SlashCommand.parse(command);
  } catch {
    throw new AppFailure({
      code: "invalid_args",
      message: "Todo command text is invalid.",
      retryable: false,
    });
  }
  if (!slashCommand.startsWith("/todo")) {
    throw new AppFailure({
      code: "invalid_args",
      message: "Todo commands must use the /todo namespace.",
      retryable: false,
    });
  }
  return gateway.run({ threadId, command: slashCommand }, options);
}
