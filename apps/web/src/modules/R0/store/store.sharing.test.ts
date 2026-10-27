import type { ChatSessionEvent, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { bashEvent, notificationEvent } from "./session-events";
import { OmpRuntimeStore } from "./store";

const threadId = "thread-sharing" as ThreadId;
const at = 1_759_600_000_000;

function userMessage(text: string, timestamp: number) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

/** History entry `index` of a chain of user messages; its message's timestamp identifies it. */
function historyEntry(index: number) {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(at + index).toISOString(),
    message: userMessage(`message ${index}`, at + index),
  };
}

function ingest(store: OmpRuntimeStore, event: unknown, seq: number): void {
  store.ingest(event as ChatSessionEvent, seq);
}

/** A store whose chat holds `count` messages from history, as a long chat does after its window fills. */
function chatOf(count: number): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId });
  store.pairEndedMessages(Array.from({ length: count }, (_, index) => historyEntry(index)));
  return store;
}

/** The median cost, in ms, of one streamed update to a message at the end of `store`'s chat (seq 1 onward). */
function streamedUpdateMs(store: OmpRuntimeStore): number {
  let seq = 0;
  const send = (event: unknown) => {
    seq += 1;
    ingest(store, { kind: "event", event }, seq);
  };
  send({ type: "message_start", messageId: "live", message: userMessage("0", at) });
  const batches: number[] = [];
  for (let batch = 0; batch < 5; batch += 1) {
    const started = performance.now();
    for (let update = 0; update < 50; update += 1) {
      send({
        type: "message_update",
        messageId: "live",
        message: userMessage("x".repeat(update + 1), at),
      });
    }
    batches.push((performance.now() - started) / 50);
  }
  batches.sort((a, b) => a - b);
  return batches[Math.floor(batches.length / 2)] ?? 0;
}

describe("OmpRuntimeStore structural sharing", () => {
  test("a commit that changes one message keeps every other message record and the order", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_start", messageId: "a", message: userMessage("first", at) },
      },
      1,
    );
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_end", messageId: "a", message: userMessage("first", at) },
      },
      2,
    );
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_start", messageId: "b", message: userMessage("second", at + 1) },
      },
      3,
    );
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_end", messageId: "b", message: userMessage("second", at + 1) },
      },
      4,
    );
    const before = store.getSnapshot();
    const [firstKey, secondKey] = before.messageOrder;
    if (firstKey === undefined || secondKey === undefined) throw new Error("two messages expected");
    const firstRecord = before.messages[firstKey];
    const secondRecord = before.messages[secondKey];

    ingest(
      store,
      {
        kind: "event",
        event: {
          type: "message_update",
          messageId: "b",
          message: userMessage("second, longer", at + 1),
        },
      },
      5,
    );
    const after = store.getSnapshot();

    expect(after.messages).not.toBe(before.messages);
    expect(after.messages[firstKey]).toBe(firstRecord);
    expect(after.messages[secondKey]).not.toBe(secondRecord);
    expect(after.messages[secondKey]?.message).toMatchObject({
      content: [{ text: "second, longer" }],
    });
    expect(after.messageOrder).toBe(before.messageOrder);
  });

  test("an event that changes no message keeps the message record, the view and the order", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_start", messageId: "a", message: userMessage("hi", at) },
      },
      1,
    );
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_end", messageId: "a", message: userMessage("hi", at) },
      },
      2,
    );
    const before = store.getSnapshot();

    ingest(store, { kind: "process", status: "ready" }, 3);
    const after = store.getSnapshot();

    expect(after.messages).toBe(before.messages);
    expect(after.messageOrder).toBe(before.messageOrder);
    expect(after.revision).toBe(before.revision + 1);
  });

  test("a reset that changes nothing keeps the snapshot and notifies no listener", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, { kind: "process", status: "ready" }, 1);
    const before = store.getSnapshot();
    const heard: number[] = [];
    store.subscribe((snapshot) => heard.push(snapshot.lastSeq));

    store.resetSequence();

    expect(store.getSnapshot()).toBe(before);
    expect(heard).toEqual([]);
  });

  test("each applied event makes exactly one commit, and a replayed event makes none", () => {
    const store = new OmpRuntimeStore({ threadId });
    let commits = 0;
    store.subscribe(() => {
      commits += 1;
    });
    const events: unknown[] = [
      { kind: "event", event: { type: "agent_start" } },
      {
        kind: "event",
        event: { type: "message_start", messageId: "m1", message: userMessage("hi", at) },
      },
      {
        kind: "event",
        event: { type: "message_update", messageId: "m1", message: userMessage("hi!", at) },
      },
      {
        kind: "event",
        event: { type: "message_end", messageId: "m1", message: userMessage("hi!", at) },
      },
      {
        kind: "event",
        event: { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
      },
      {
        kind: "event",
        event: {
          type: "tool_execution_update",
          toolCallId: "t1",
          toolName: "bash",
          partialResult: {},
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "bash",
          result: {},
          isError: false,
        },
      },
      bashEvent({ status: "running", command: "ls", startedAt: 1 }),
      { kind: "process", status: "ready" },
      notificationEvent({
        type: "extension_ui_request",
        id: "ask-1",
        method: "select",
        title: "Pick",
        options: ["a"],
      }),
      { kind: "event", event: { type: "session_settled" } },
    ];
    const perEvent = events.map((event, index) => {
      const before = commits;
      ingest(store, event, index + 1);
      return commits - before;
    });

    expect(perEvent).toEqual(events.map(() => 1));
    const replayed = commits;
    ingest(store, events[0], 1);
    expect(commits).toBe(replayed);
  });

  test("a streamed message stays in the order once, through its start, updates, end and a repeated start", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_start", messageId: "r", message: userMessage("x", at) },
      },
      1,
    );
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_update", messageId: "r", message: userMessage("xy", at) },
      },
      2,
    );
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_end", messageId: "r", message: userMessage("xy", at) },
      },
      3,
    );
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_start", messageId: "r", message: userMessage("xy", at) },
      },
      4,
    );

    const snapshot = store.getSnapshot();
    expect(snapshot.messageOrder).toHaveLength(1);
    expect(Object.keys(snapshot.messages)).toEqual([...snapshot.messageOrder]);
  });

  test("the message and tool records cannot be written, and their records are frozen", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(
      store,
      {
        kind: "event",
        event: { type: "message_start", messageId: "w", message: userMessage("w", at) },
      },
      1,
    );
    ingest(
      store,
      {
        kind: "event",
        event: { type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {} },
      },
      2,
    );
    const snapshot = store.getSnapshot();
    const [key] = snapshot.messageOrder;
    if (key === undefined) throw new Error("one message expected");

    expect(Reflect.set(snapshot.messages, "stream:forged", {})).toBe(false);
    expect(Reflect.deleteProperty(snapshot.messages, key)).toBe(false);
    expect(Reflect.set(snapshot.tools, "forged", {})).toBe(false);
    expect(snapshot.messages[key]).toBeDefined();
    expect(Object.isFrozen(snapshot.messages[key])).toBe(true);
    const [tool] = Object.values(snapshot.tools);
    expect(Object.isFrozen(tool)).toBe(true);
  });
});

describe("OmpRuntimeStore per-event cost does not grow with the chat", () => {
  test("a streamed update costs the same at 27,000 messages as at 1,000", () => {
    const small = streamedUpdateMs(chatOf(1_000));
    const large = streamedUpdateMs(chatOf(27_000));

    expect(large).toBeLessThan(Math.max(small * 3, 0.5));
  }, 120_000);
});
