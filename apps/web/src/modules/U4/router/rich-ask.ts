import {
  AppFailure,
  type CapabilityMap,
  type RpcSessionSend,
  type ThreadId,
} from "@omp-app/contracts";
import { ASK_DIALOG_CAPABILITY, DIALOG_CAPABILITY } from "../contract/dialog";

/**
 * True when omp offers the extension dialogs and the command that opts a session in to rich `ask` requests
 * (`research/modules/U4.md` §3.4). An omp that lacks either keeps the select-list fallback.
 */
export function richAskOffered(capabilities: CapabilityMap): boolean {
  return (
    capabilities[DIALOG_CAPABILITY]?.state === "available" &&
    capabilities[ASK_DIALOG_CAPABILITY]?.state === "available"
  );
}

/**
 * Opts one omp session in to rich `ask` requests: one request per `ask` call, carrying every question with its radio
 * or checkbox options and free text. Without the opt-in omp asks each question as a select list, which cannot show
 * which options are ticked. The opt-in lasts for one omp process; the server sends it again after a restart.
 * Fails with a typed `omp_error` when omp does not confirm it.
 */
export async function optIntoRichAsk(send: RpcSessionSend, threadId: ThreadId): Promise<void> {
  const result: unknown = await send({
    threadId,
    command: { type: "set_ask_dialog", enabled: true },
  });
  if (!isEnabledAnswer(result)) {
    throw new AppFailure({
      code: "omp_error",
      message: "omp did not confirm rich ask questions.",
      retryable: false,
    });
  }
}

function isEnabledAnswer(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && "enabled" in value && value.enabled === true
  );
}
