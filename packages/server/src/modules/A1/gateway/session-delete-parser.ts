import { AppFailure, type SessionDeleteCommandResult } from "@omp-app/contracts";
import type { CommandParserContext } from "./gateway";

/*
 * The typed parser for `/session delete` (issue #1351). omp deletes the chat's file itself and prints one line
 * (builtin-session.ts:287-288 at omp v18.6.1). Only that single line, from a command that
 * started no agent turn, reads as `deleted`. Any other reply (a refusal, a usage line) is `unknown`: omp's own words
 * are kept as omp sent them, and the app changes nothing.
 */

/** builtin-session.ts:287-288 at omp v18.6.1: `Session deleted: <the file's path>. Use ACP ...`, with the path between the two parts. */
const DELETED_LINE =
  /^Session deleted: .+\. Use ACP `session\/load` to switch to another session\.$/u;

export function parseSessionDeleteReply(context: CommandParserContext): SessionDeleteCommandResult {
  if (context.command !== "/session delete") {
    throw new AppFailure({
      code: "internal",
      message: `The app could not read omp's reply to ${context.command}.`,
      retryable: false,
    });
  }
  const outputs = context.outputs.map((output) => output.text);
  const [only, ...rest] = outputs;
  const deleted =
    only !== undefined && rest.length === 0 && !context.agentInvoked && DELETED_LINE.test(only);
  return deleted ? { outcome: "deleted", outputs } : { outcome: "unknown", outputs };
}
