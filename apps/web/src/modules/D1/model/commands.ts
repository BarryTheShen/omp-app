import type { AppClient } from "@omp-app/client";
import type { CommandRunResult, SlashCommand, ThreadId } from "@omp-app/contracts";
import { OmpCommandGateway as OmpCommandGatewayPort } from "@omp-app/contracts";

export interface ModelCommandSource {
  readonly run: (command: SlashCommand) => Promise<CommandRunResult>;
}

/** Real A1.8/A1.9 command-gateway implementation for D1 model commands. */
export function createModelCommandSource(
  client: AppClient,
  threadId: ThreadId,
): ModelCommandSource {
  const gateway = client.port(OmpCommandGatewayPort);
  return {
    run: (command) => gateway.run({ threadId, command }),
  };
}

export function modelCommand(
  command: "model" | "switch" | "effort",
  argument?: string,
): SlashCommand {
  const suffix = argument?.trim();
  return `/${command}${suffix ? ` ${suffix}` : ""}` as SlashCommand;
}
