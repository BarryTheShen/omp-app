import { AppFailure, type SessionDeleteCommandResult } from "@omp-app/contracts";
import type { CommandParserContext } from "./gateway";

/*
 * The typed parser for `/session delete` (issue #1351; typed refusals in #1350). omp deletes the chat's file itself and
 * prints one line (omp v18.6.1, builtin-session.ts): the deleted line at :287-288, a refusal while streaming at :274, a
 * chat with no session file at :276, and a failed delete at :285. Any other reply, or a reply to a command that started an
 * agent turn, is unknown: the app changes nothing. The browser never reads these words.
 */

/** builtin-session.ts:287-288: `Session deleted: <the file's path>. Use ACP ...`, with the path between the two parts. */
const DELETED_LINE =
  /^Session deleted: .+\. Use ACP `session\/load` to switch to another session\.$/u;
/** builtin-session.ts:274 */
const STREAMING_LINE = "Cannot delete the session while streaming.";
/** builtin-session.ts:276 */
const NOT_SAVED_LINE = "No session file to delete (in-memory session).";
/** builtin-session.ts:285: `Failed to delete session: <the error>`. */
const FAILED_LINE = /^Failed to delete session: .+$/u;

export function parseSessionDeleteReply(context: CommandParserContext): SessionDeleteCommandResult {
  if (context.command !== "/session delete") {
    throw new AppFailure({
      code: "internal",
      message: `The app could not read omp's reply to ${context.command}.`,
      retryable: false,
    });
  }
  const [only, ...rest] = context.outputs.map((output) => output.text);
  if (only === undefined || rest.length > 0 || context.agentInvoked) return { outcome: "unknown" };
  if (DELETED_LINE.test(only)) return { outcome: "deleted" };
  if (only === STREAMING_LINE) return { outcome: "refused", reason: "running" };
  if (only === NOT_SAVED_LINE) return { outcome: "refused", reason: "not-saved" };
  if (FAILED_LINE.test(only)) return { outcome: "failed" };
  return { outcome: "unknown" };
}
