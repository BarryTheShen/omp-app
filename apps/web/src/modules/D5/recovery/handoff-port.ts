import {
  AppFailure,
  type ChatSessionClient,
  SessionFilePath,
  type ThreadId,
} from "@omp-app/contracts";
import type { ChatHostMethodMap } from "@omp-app/contracts/chat-host";
import { type HandoffPort, type HandoffRequest, HandoffResult } from "../contract";

/**
 * omp's handoff answer as the contract's HandoffResult. omp answers `{ savedPath? }` when it made a
 * handoff (a path omp left out arrives as no key at all) and `null` when it made none, which is a failure
 * here, not a success. Refusals (a reply in flight, nothing to hand off) reach the caller as the request's
 * own failure.
 */
export function handoffResultOf(
  payload: Partial<NonNullable<ChatHostMethodMap["handoff"]["result"]>> | null,
): HandoffResult {
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

/** The `HandoffPort` over the chat session port, for the thread that `threadId` names at the call. */
export function createHandoffPort(
  session: Pick<ChatSessionClient, "request">,
  threadId: () => ThreadId,
): HandoffPort {
  return {
    createHandoff: async (request?: HandoffRequest) => {
      // An empty focus is no focus: `/handoff` with nothing after it sends the bare command.
      const instructions = request?.customInstructions?.trim();
      const params =
        instructions === undefined || instructions === ""
          ? {}
          : { customInstructions: instructions };
      return handoffResultOf(
        await session.request({ threadId: threadId(), method: "handoff", params }),
      );
    },
  };
}
