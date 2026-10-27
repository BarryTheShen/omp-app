import type { ChatSessionRequest } from "@omp-app/contracts";
import type { P3RunStatus } from "./status";

/** The requests that carry a message the person sent: a prompt, a steer, a follow-up, or a queued message sent now. */
const MESSAGE_METHODS: ReadonlySet<string> = new Set([
  "prompt",
  "steer",
  "follow_up",
  "promote_queued_message",
]);

/**
 * Wraps a chat's requests so that a message the person sends, once omp has accepted it, ends a finished or
 * failed run's notice: the conversation has moved on, so the notice stops offering Try again and stops
 * answering Alt+R. A message omp refuses ends nothing. Every other request passes through unchanged,
 * including the reads the app makes while a new chat opens and the removal of a queued message.
 */
export function endNoticeOnPrompt(
  request: ChatSessionRequest,
  status: Pick<P3RunStatus, "dismiss">,
): ChatSessionRequest {
  return async (args, options) => {
    const result = await request(args, options);
    if (MESSAGE_METHODS.has(args.method)) status.dismiss();
    return result;
  };
}
