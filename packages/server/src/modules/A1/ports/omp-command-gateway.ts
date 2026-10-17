import {
  AppFailure,
  type BackgroundJobStop,
  CommandOutputEvent,
  type CommandRunResult,
  CompactionEvent,
  DumpReport,
  type DumpScope,
  ModeChangeResult,
  modeChangeCommand,
  OmpCommandGateway,
  SessionDeleteCommandResult,
  SessionFileChanged,
  SessionFileStore,
  ShareResult,
  streamKey,
  ToolsAvailabilityResult,
} from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { createA1PortRegistration } from "./helper";

/**
 * `/jobs kill <id>` as omp answers it: the job it stopped, or one it had already finished. Any other reply keeps
 * nothing, so a stop that did not happen is never kept as stopped.
 */
function backgroundJobStopOf(
  command: string,
  result: CommandRunResult,
): Pick<BackgroundJobStop, "jobId" | "status"> | undefined {
  const killed = /^\/jobs kill ([A-Za-z0-9_-]{1,60})$/u.exec(command);
  if (killed === null || result.status !== "completed") return undefined;
  const jobId = killed[1] ?? "";
  const words = result.outputs
    .map((output) => output.text.replace(/\s+/gu, " ").trim())
    .filter((text) => text !== "")
    .join(" ");
  if (words === `Cancelled background job ${jobId}.`) return { jobId, status: "stopped" };
  if (words === `No running background job with id "${jobId}".`)
    return { jobId, status: "finished" };
  return undefined;
}

/** The command each dump scope runs in omp: `/dump`, `/dump all`, and `/dump anon` (the anonymized archive). */
const DUMP_COMMANDS: Readonly<Record<DumpScope, string>> = {
  session: "/dump",
  all: "/dump all",
  anon: "/dump anon",
};

export function createOmpCommandGatewayRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "output",
      subscribe: (listener: (payload: unknown) => void) =>
        context.ompCommandGateway.onOutput(listener as (event: CommandOutputEvent) => void),
      scope: (payload: unknown) => CommandOutputEvent.parse(payload).threadId,
    },
    {
      event: "compaction",
      subscribe: (listener: (payload: unknown) => void) =>
        context.ompCommandGateway.onCompaction(listener as (event: CompactionEvent) => void),
      scope: (payload: unknown) => CompactionEvent.parse(payload).threadId,
    },
  ];
  return createA1PortRegistration(
    OmpCommandGateway,
    {
      run: async (args, handlerContext) => {
        const result = await context.ompCommandGateway.run(args, { signal: handlerContext.signal });
        const stop = backgroundJobStopOf(args.command, result);
        if (stop !== undefined) await context.backgroundJobStopStore.record(args.threadId, stop);
        return result;
      },
      tools: async (args, handlerContext): Promise<ToolsAvailabilityResult> => {
        const { data } = await context.ompCommandGateway.runWithParser<ToolsAvailabilityResult>(
          { threadId: args.threadId, command: "/tools" },
          { signal: handlerContext.signal },
        );
        return typedReply(data, (value) => ToolsAvailabilityResult.parse(value), "/tools");
      },
      backgroundJobStops: async (args) => ({
        stops: [...(await context.backgroundJobStopStore.list(args.threadId))],
      }),
      share: async (args, handlerContext) => {
        const { data } = await context.ompCommandGateway.runWithParser<ShareResult>(
          { threadId: args.threadId, command: "/share" },
          { signal: handlerContext.signal },
        );
        return typedReply(data, (value) => ShareResult.parse(value), "/share");
      },
      dump: async (args, handlerContext) => {
        const command = DUMP_COMMANDS[args.scope];
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
        const check = await context.sessionFileStore.checkOmpDelete(args.threadId, caller);
        if (check.outcome === "refused") return { outcome: "refused", reason: check.reason };
        const { data } = await context.ompCommandGateway.runWithParser<SessionDeleteCommandResult>(
          { threadId: args.threadId, command },
          { signal: handlerContext.signal },
        );
        const result = typedReply(
          data,
          (value) => SessionDeleteCommandResult.parse(value),
          command,
        );
        if (result.outcome !== "deleted" || check.file === undefined) return result;
        const finished = await context.sessionFileStore
          .finishOmpDelete(check.file, caller)
          .catch((error: unknown) => {
            // A stop omp did not make, or a file that would not go: the file is left as it is, and the person tries again.
            if (error instanceof AppFailure) return undefined;
            throw error;
          });
        if (finished === undefined) return { outcome: "failed" };
        // omp deleted its own file, but another view took the chat back while omp stopped: the file stays, and the reason is said.
        if (finished.outcome === "refused") return { outcome: "refused", reason: finished.reason };
        // The sidebar's own delete publishes this removal on the session file stream, and every open tab drops the row.
        // A typed delete publishes the same change once the file is gone and omp has stopped.
        context.publish(
          streamKey(SessionFileStore.name, "changed"),
          SessionFileChanged.parse({
            folder: check.file.cwd,
            sessionFile: check.file.sessionFile,
            id: check.file.id,
            kind: "removed",
          }),
        );
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
