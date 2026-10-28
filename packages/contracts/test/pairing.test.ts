import { describe, expect, test } from "bun:test";
import { messageIdentity, type OmpMessage, pairEndedMessages } from "../src";

// Every message below ends in the same millisecond.
const at = 1_759_600_000_000;
const iso = new Date(at).toISOString();
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, attribution?: "user" | "agent"): OmpMessage {
  return { role: "user", content: text, timestamp: at, attribution };
}

function assistant(
  text: string,
  responseId?: string,
  stopReason: "stop" | "error" = "stop",
): OmpMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake-openai",
    model: "fake-model",
    usage,
    stopReason,
    timestamp: at,
    responseId,
  };
}

function toolResult(toolCallId: string): OmpMessage {
  const content = [{ type: "text" as const, text: "ok" }];
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content,
    isError: false,
    timestamp: at,
  };
}

/** A `message` entry as `get_entries` returns it. */
function entry(id: string, message: OmpMessage) {
  return { type: "message", id, parentId: null, timestamp: "2026-10-04T12:00:01.000Z", message };
}

/** `pairEndedMessages` with its branded entry ids widened to strings for comparison. */
function paired(ended: readonly OmpMessage[], entries: readonly unknown[]): (string | undefined)[] {
  return pairEndedMessages(ended, entries);
}

describe("pairEndedMessages, same millisecond and same role", () => {
  test("user messages with one attribution pair in message_end order", () => {
    const first = user("one");
    const second = user("two");
    const entries = [entry("e1", first), entry("e2", second)];
    expect(paired([first, second], entries)).toEqual(["e1", "e2"]);
  });

  test("attribution tells user messages apart", () => {
    const typed = user("typed");
    const injected = user("injected", "agent");
    const entries = [entry("eInjected", injected), entry("eTyped", typed)];
    expect(paired([typed, injected], entries)).toEqual(["eTyped", "eInjected"]);
  });

  test("responseId tells assistant replies apart", () => {
    const first = assistant("one", "resp-1");
    const second = assistant("two", "resp-2");
    const entries = [entry("e2", second), entry("e1", first)];
    expect(paired([first, second], entries)).toEqual(["e1", "e2"]);
  });

  test("without responseId, stopReason tells replies apart and order settles the rest", () => {
    const failed = assistant("a", undefined, "error");
    const done = assistant("b");
    const doneAgain = assistant("c");
    const entries = [
      entry("eDone", done),
      entry("eFailed", failed),
      entry("eDoneAgain", doneAgain),
    ];
    expect(paired([failed, done, doneAgain], entries)).toEqual(["eFailed", "eDone", "eDoneAgain"]);
  });

  test("toolCallId tells tool results apart", () => {
    const first = toolResult("call_1");
    const second = toolResult("call_2");
    const entries = [entry("e2", second), entry("e1", first)];
    expect(paired([first, second], entries)).toEqual(["e1", "e2"]);
  });

  test("custom messages pair with custom_message entries by customType and ISO time", () => {
    const note: OmpMessage = {
      role: "custom",
      customType: "advisor-note",
      content: "x",
      display: true,
      timestamp: at,
    };
    const irc: OmpMessage = {
      role: "hookMessage",
      customType: "irc",
      content: "y",
      display: true,
      timestamp: at,
    };
    const custom = {
      type: "custom_message",
      parentId: null,
      content: "z",
      display: true,
      timestamp: iso,
    };
    const entries = [
      { ...custom, id: "eIrc", customType: "irc" },
      { ...custom, id: "eNote", customType: "advisor-note" },
    ];
    expect(paired([note, irc], entries)).toEqual(["eNote", "eIrc"]);
  });
});

describe("pairEndedMessages, other cases", () => {
  test("content is not compared, so an obfuscated entry still pairs", () => {
    const shown = assistant("the real value", "resp-1");
    const stored = assistant("$$a1b2c3$$", "resp-1");
    expect(paired([shown], [entry("e1", stored)])).toEqual(["e1"]);
  });

  test("an entry pairs once; unmatched and unpersisted messages stay unpaired", () => {
    const message = user("once");
    const bash: OmpMessage = {
      role: "bashExecution",
      command: "ls",
      output: "",
      cancelled: false,
      truncated: false,
      exitCode: 0,
      timestamp: at,
    };
    const modelChange = { type: "model_change", id: "eModel", parentId: null, timestamp: iso };
    const entries = [modelChange, entry("e1", message), entry("eBash", bash)];
    expect(paired([message, user("once"), bash], entries)).toEqual(["e1", undefined, undefined]);
  });

  test("messageIdentity changes with each identity field and ignores content", () => {
    const base = assistant("x", "resp-1");
    const changes: Array<Partial<Record<string, unknown>>> = [
      { timestamp: at + 1 },
      { provider: "other" },
      { model: "other" },
      { responseId: "resp-2" },
      { stopReason: "error" },
    ];
    for (const change of changes) {
      expect(messageIdentity({ ...base, ...change })).not.toBe(messageIdentity(base));
    }
    expect(messageIdentity({ ...base, content: [] })).toBe(messageIdentity(base));
    expect(messageIdentity({ role: "assistant", timestamp: at })).toBeUndefined();
  });
});
