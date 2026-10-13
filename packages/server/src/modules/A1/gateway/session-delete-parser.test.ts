import { describe, expect, test } from "bun:test";
import { AppFailure } from "@omp-app/contracts";
import type { CommandParserContext } from "./gateway";
import { parseSessionDeleteReply } from "./session-delete-parser";

/** The context the gateway hands a parser for one command whose command_output texts are `texts`. */
function replyTo(
  command: string,
  texts: readonly string[],
  agentInvoked = false,
): CommandParserContext {
  return {
    command,
    agentInvoked,
    outputs: texts.map((text) => ({ text })),
    sessionUpdates: [],
    configUpdates: [],
  };
}

/** builtin-session.ts:287-288 at omp v18.6.1, with the path omp printed: the file it deleted. */
const DELETED = (path: string) =>
  `Session deleted: ${path}. Use ACP \`session/load\` to switch to another session.`;

describe("parseSessionDeleteReply on omp's /session delete replies", () => {
  test("omp's one deleted line, from a command that ran no agent turn, reads as deleted, with its words kept", () => {
    const line = DELETED("/sessions/example/one.jsonl");
    expect(parseSessionDeleteReply(replyTo("/session delete", [line]))).toEqual({
      outcome: "deleted",
      outputs: [line],
    });
  });

  test("a refusal or a usage line is unknown: omp's words are kept, and nothing is read as deleted", () => {
    for (const text of [
      "Cannot delete the session while streaming.",
      "No session file to delete (in-memory session).",
      "Failed to delete session: EACCES",
      "Usage: /session [info|delete|pin [account]]",
    ]) {
      expect(parseSessionDeleteReply(replyTo("/session delete", [text])), text).toEqual({
        outcome: "unknown",
        outputs: [text],
      });
    }
  });

  test("a deleted line that comes with another line, or from a command that invoked an agent turn, is not read as deleted", () => {
    const line = DELETED("/sessions/example/one.jsonl");
    expect(
      parseSessionDeleteReply(replyTo("/session delete", [line, "A second line."])).outcome,
    ).toBe("unknown");
    expect(parseSessionDeleteReply(replyTo("/session delete", [line], true)).outcome).toBe(
      "unknown",
    );
  });

  test("text that only starts like the deleted line, without its ACP part, is unknown", () => {
    expect(
      parseSessionDeleteReply(replyTo("/session delete", ["Session deleted: /sessions/one.jsonl."]))
        .outcome,
    ).toBe("unknown");
  });

  test("a reply with no output at all is unknown", () => {
    expect(parseSessionDeleteReply(replyTo("/session delete", []))).toEqual({
      outcome: "unknown",
      outputs: [],
    });
  });

  test("a context for another command is refused as an internal failure, never guessed", () => {
    expect(() =>
      parseSessionDeleteReply(replyTo("/session info", [DELETED("/sessions/example/one.jsonl")])),
    ).toThrow(AppFailure);
  });
});
