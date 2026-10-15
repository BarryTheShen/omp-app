import {
  AppFailure,
  type OmpWire,
  type RpcSessionClient,
  SessionFilePath,
  type ThreadId,
} from "@omp-app/contracts";
import { type HandoffPort, type HandoffRequest, HandoffResult } from "../contract";

/**
 * omp's handoff answer as the contract's HandoffResult. omp answers `{ savedPath? }` when it made a
 * handoff and `null` when it made none, which is a failure here, not a success. Refusals (a reply in
 * flight, nothing to hand off) reach the caller as the send's own failure.
 */
export function handoffResultOf(payload: OmpWire.HandoffResult | null): HandoffResult {
  if (payload === null) {
    throw new AppFailure({
      code: "unavailable",
      message: "No handoff was made.",
      retryable: false,
    });
  }
  // omp answers the `handoff` command without a saved path. omp writes an automatic handoff to `handoff-<ts>.md`
  // only when it is auto-triggered (auto-compaction), and the command the app sends never sets that flag. The
  // contract takes only absolute `.jsonl` session files, so a path it rejects is not reported.
  const savedPath = SessionFilePath.safeParse(payload.savedPath ?? null);
  return HandoffResult.parse({
    savedPath: savedPath.success ? savedPath.data : null,
    summaryEntryId: null,
    // omp answers only once the handoff has finished, so no prompt is still in flight.
    sessionSettled: true,
  });
}

/** The `HandoffPort` over A0's typed `send`, for the thread that `threadId` names at the call. */
export function createHandoffPort(
  session: Pick<RpcSessionClient, "send">,
  threadId: () => ThreadId,
): HandoffPort {
  return {
    createHandoff: async (request?: HandoffRequest) => {
      // An empty focus is no focus: `/handoff` with nothing after it sends the bare command.
      const instructions = request?.customInstructions?.trim();
      const command =
        instructions === undefined || instructions === ""
          ? { type: "handoff" as const }
          : { type: "handoff" as const, customInstructions: instructions };
      return handoffResultOf(await session.send({ threadId: threadId(), command }));
    },
  };
}
