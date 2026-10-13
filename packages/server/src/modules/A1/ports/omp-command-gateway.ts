import {
  AppFailure,
  CommandOutputEvent,
  DumpReport,
  ModeChangeResult,
  modeChangeCommand,
  OmpCommandGateway,
  SessionDeleteCommandResult,
  ShareResult,
} from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { createA1PortRegistration } from "./helper";

export function createOmpCommandGatewayRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "output",
      subscribe: (listener: (payload: unknown) => void) =>
        context.ompCommandGateway.onOutput(listener as (event: CommandOutputEvent) => void),
      scope: (payload: unknown) => CommandOutputEvent.parse(payload).threadId,
    },
  ];
  return createA1PortRegistration(
    OmpCommandGateway,
    {
      run: (args, handlerContext) =>
        context.ompCommandGateway.run(args, { signal: handlerContext.signal }),
      share: async (args, handlerContext) => {
        const { data } = await context.ompCommandGateway.runWithParser<ShareResult>(
          { threadId: args.threadId, command: "/share" },
          { signal: handlerContext.signal },
        );
        return typedReply(data, (value) => ShareResult.parse(value), "/share");
      },
      dump: async (args, handlerContext) => {
        const command = args.scope === "all" ? "/dump all" : "/dump";
        const { data } = await context.ompCommandGateway.runWithParser<DumpReport>(
          { threadId: args.threadId, command },
          { signal: handlerContext.signal },
        );
        return typedReply(data, (value) => DumpReport.parse(value), command);
      },
      modeChange: async (args, handlerContext): Promise<ModeChangeResult> => {
        const command = modeChangeCommand(args.request);
        try {
          const { data } = await context.ompCommandGateway.runWithParser<ModeChangeResult>(
            { threadId: args.threadId, command },
            { signal: handlerContext.signal },
          );
          return typedReply(data, (value) => ModeChangeResult.parse(value), command);
        } catch (cause) {
          // The gateway fails with `unavailable` only when omp's command list lacks the command, before any prompt.
          if (cause instanceof AppFailure && cause.appError.code === "unavailable") {
            return { outcome: "unsupported", mode: args.request.mode, reason: "not-offered" };
          }
          throw cause;
        }
      },
      sessionDelete: async (args, handlerContext): Promise<SessionDeleteCommandResult> => {
        const command = "/session delete";
        const caller = { connectionId: handlerContext.connectionId };
        // The server checks the chat before omp deletes its file, then finishes the delete once omp reports it: omp can
        // write the chat back when its omp stops, so the server stops it first, as the sidebar's own delete does.
        const file = await context.sessionFileStore.checkOmpDelete(args.threadId, caller);
        const { data } = await context.ompCommandGateway.runWithParser<SessionDeleteCommandResult>(
          { threadId: args.threadId, command },
          { signal: handlerContext.signal },
        );
        const result = typedReply(
          data,
          (value) => SessionDeleteCommandResult.parse(value),
          command,
        );
        if (result.outcome === "deleted" && file !== undefined) {
          await context.sessionFileStore.finishOmpDelete(file, caller);
        }
        return result;
      },
    },
    context.publish,
    bindings,
    context.watchStreamActivity,
  );
}

/**
 * The parser's typed value, checked once more here: a command with no parser hands back its raw frames,
 * and raw frames are never a typed reply. Any mismatch is an `internal` failure, not a guess.
 */
function typedReply<T>(value: unknown, parse: (value: unknown) => T, command: string): T {
  try {
    return parse(value);
  } catch {
    throw new AppFailure({
      code: "internal",
      message: `The app could not read omp's reply to ${command}.`,
      retryable: false,
    });
  }
}
