import type { RpcSessionSend } from "@omp-app/contracts";
import type { P3RunStatus } from "./status";

/** The commands that carry a message the person sent: a prompt, a steer, a follow-up, or a queued message sent now. */
const MESSAGE_COMMANDS: ReadonlySet<string> = new Set([
  "prompt",
  "steer",
  "follow_up",
  "promote_queued_message",
]);

/**
 * Wraps a chat's send so that a message the person sends, once omp has accepted it, ends a finished or
 * failed run's notice: the conversation has moved on, so the notice stops offering Try again and stops
 * answering Alt+R. A message omp refuses ends nothing. Every other command passes through unchanged,
 * including the reads the app makes while a new chat opens and the removal of a queued message.
 */
export function endNoticeOnPrompt(
  send: RpcSessionSend,
  status: Pick<P3RunStatus, "dismiss">,
): RpcSessionSend {
  return async (args, options) => {
    const result = await send(args, options);
    if (MESSAGE_COMMANDS.has(args.command.type)) status.dismiss();
    return result;
  };
}
