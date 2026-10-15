import type { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "./store";

const threadId = "thread-voice" as ThreadId;
const at = 1_759_600_000_000;

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** One message of a settled turn, as omp's session history holds it. */
function historyEntry(id: string, parentId: string | null, message: Record<string, unknown>) {
  return { type: "message", id, parentId, timestamp: new Date(at).toISOString(), message };
}

function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: at };
}

function assistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "test",
    usage,
    stopReason: "stop",
    timestamp: at,
  };
}

/** The text of each message in the transcript, in order. */
function admittedTexts(store: OmpRuntimeStore): string[] {
  const snapshot = store.getSnapshot();
  return snapshot.messageOrder.map((key) => {
    const message = snapshot.messages[key]?.message as unknown as
      | { readonly content: ReadonlyArray<{ readonly text: string }> }
      | undefined;
    return message?.content[0]?.text ?? "";
  });
}

describe("R0 admission of finished live-voice turns", () => {
  test("a finished turn joins the messages, and omp's transcript is left alone", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.admitVoiceTurn({ sessionId: "live-1", role: "user", turn: 0, text: "hello" });
    const snapshot = store.getSnapshot();
    expect(snapshot.messageOrder).toHaveLength(1);
    const [key] = snapshot.messageOrder;
    if (key === undefined) throw new Error("the turn was not admitted");
    expect(snapshot.messages[key]).toMatchObject({
      status: "ended",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    expect(snapshot.transcript.order).toEqual([]);
  });

  test("a later final for the same turn replaces its text, and the turn appears once", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.admitVoiceTurn({ sessionId: "live-1", role: "user", turn: 0, text: "hel" });
    store.admitVoiceTurn({ sessionId: "live-1", role: "user", turn: 0, text: "hello there" });
    expect(store.getSnapshot().messageOrder).toHaveLength(1);
    expect(admittedTexts(store)).toEqual(["hello there"]);
  });

  test("turns keep their order, and a different session is a different turn", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.admitVoiceTurn({ sessionId: "live-1", role: "user", turn: 0, text: "one" });
    store.admitVoiceTurn({ sessionId: "live-1", role: "assistant", turn: 1, text: "two" });
    store.admitVoiceTurn({ sessionId: "live-2", role: "user", turn: 0, text: "three" });
    expect(admittedTexts(store)).toEqual(["one", "two", "three"]);
  });

  test("a settled turn does not move the voice lines admitted before it behind its history", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.admitVoiceTurn({ sessionId: "live-1", role: "user", turn: 0, text: "hello omp" });
    store.admitVoiceTurn({ sessionId: "live-1", role: "assistant", turn: 1, text: "Hi there." });
    store.pairEndedMessages([
      historyEntry("entry-prompt", null, userMessage("after voice")),
      historyEntry("entry-answer", "entry-prompt", assistantMessage("pong")),
    ]);
    expect(admittedTexts(store)).toEqual(["hello omp", "Hi there.", "after voice", "pong"]);
  });

  test("a voice line admitted between two settled turns stays between them", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.pairEndedMessages([
      historyEntry("entry-one", null, userMessage("first")),
      historyEntry("entry-two", "entry-one", assistantMessage("pong")),
    ]);
    store.admitVoiceTurn({ sessionId: "live-1", role: "user", turn: 2, text: "between" });
    store.pairEndedMessages([
      historyEntry("entry-one", null, userMessage("first")),
      historyEntry("entry-two", "entry-one", assistantMessage("pong")),
      historyEntry("entry-three", "entry-two", userMessage("second")),
      historyEntry("entry-four", "entry-three", assistantMessage("pong")),
    ]);
    expect(admittedTexts(store)).toEqual(["first", "pong", "between", "second", "pong"]);
  });
});
