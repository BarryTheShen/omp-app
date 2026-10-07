import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  OmpCommandGateway,
  type PortCallOptions,
  type SlashCommand,
  type ThreadId,
} from "@omp-app/contracts";
import type { P7CommandPort, P7CommandResult } from "../contract";
import { validateP7Command } from "./grammar";

/** Reuses A1's typed command gateway; command outputs remain opaque to this adapter. */
export function createP7CommandGateway(client: AppClient): P7CommandPort {
  return client.port(OmpCommandGateway);
}

/** Validates P7 command syntax before passing the original command to omp through A1. */
export async function runP7Command(
  gateway: P7CommandPort,
  threadId: ThreadId,
  input: string,
  options?: Pick<PortCallOptions, "signal">,
): Promise<P7CommandResult> {
  const parsed = validateP7Command(input);
  if (parsed.state === "invalid") {
    throw new AppFailure({ code: "invalid_args", message: parsed.message, retryable: false });
  }

  const command: SlashCommand = parsed.value.command;
  return gateway.run({ threadId, command }, options);
}
