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

/** builtin-session.ts:286-287 at omp v18.12.6, with the path omp printed: the file it deleted. */
const DELETED = (path: string) =>
  `Session deleted: ${path}. Use ACP \`session/load\` to switch to another session.`;

describe("parseSessionDeleteReply on omp's /session delete replies", () => {
  test("omp's one deleted line, from a command that ran no agent turn, reads as deleted", () => {
    const line = DELETED("/sessions/example/one.jsonl");
    expect(parseSessionDeleteReply(replyTo("/session delete", [line]))).toEqual({
      outcome: "deleted",
    });
  });

  test("omp's refusal while it streams reads as refused, because the chat's turn runs", () => {
    expect(
      parseSessionDeleteReply(
        replyTo("/session delete", ["Cannot delete the session while streaming."]),
      ),
    ).toEqual({ outcome: "refused", reason: "running" });
  });

  test("omp's reply for a chat with no session file reads as refused, because the chat is not saved yet", () => {
    expect(
      parseSessionDeleteReply(
        replyTo("/session delete", ["No session file to delete (in-memory session)."]),
      ),
    ).toEqual({ outcome: "refused", reason: "not-saved" });
  });

  test("omp's failed delete reads as failed, and its error text is not part of the result", () => {
    expect(
      parseSessionDeleteReply(replyTo("/session delete", ["Failed to delete session: EACCES"])),
    ).toEqual({ outcome: "failed" });
  });

  test("a usage line or any other single line is unknown, and nothing reads as deleted", () => {
    expect(
      parseSessionDeleteReply(
        replyTo("/session delete", ["Usage: /session [info|delete|pin [account]]"]),
      ),
    ).toEqual({ outcome: "unknown" });
  });

  test("a refusal line with another line, or from a command that invoked an agent turn, is unknown", () => {
    const streaming = "Cannot delete the session while streaming.";
    expect(
      parseSessionDeleteReply(replyTo("/session delete", [streaming, "A second line."])),
    ).toEqual({
      outcome: "unknown",
    });
    expect(parseSessionDeleteReply(replyTo("/session delete", [streaming], true))).toEqual({
      outcome: "unknown",
    });
  });

  test("a deleted line with another line, or from a command that invoked an agent turn, is not read as deleted", () => {
    const line = DELETED("/sessions/example/one.jsonl");
    expect(parseSessionDeleteReply(replyTo("/session delete", [line, "A second line."]))).toEqual({
      outcome: "unknown",
    });
    expect(parseSessionDeleteReply(replyTo("/session delete", [line], true))).toEqual({
      outcome: "unknown",
    });
  });

  test("text that only starts like the deleted line, without its ACP part, is unknown", () => {
    expect(
      parseSessionDeleteReply(
        replyTo("/session delete", ["Session deleted: /sessions/one.jsonl."]),
      ),
    ).toEqual({ outcome: "unknown" });
  });

  test("a reply with no output at all is unknown", () => {
    expect(parseSessionDeleteReply(replyTo("/session delete", []))).toEqual({ outcome: "unknown" });
  });

  test("a context for another command is refused as an internal failure, never guessed", () => {
    expect(() =>
      parseSessionDeleteReply(replyTo("/session info", [DELETED("/sessions/example/one.jsonl")])),
    ).toThrow(AppFailure);
  });
});
