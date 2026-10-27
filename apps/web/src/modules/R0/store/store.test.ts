import type {
  ChatSessionEvent,
  EntryId,
  MessageKey,
  ProvisionalMessageKey,
  ThreadId,
  ToolCallId,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  bashEvent,
  dialogCancelEvent,
  dialogEvent,
  hostCallCancelEvent,
  hostCallEvent,
  notificationEvent,
  promptResultEvent,
  uiEvent,
} from "./session-events";
import { OmpRuntimeStore, type RuntimeMessage, rowIdOf } from "./store";

const threadId = "thread-r0" as ThreadId;
const at = 1_759_600_000_000;

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  text: string,
  options: { responseId?: string; stopReason?: "stop" | "toolUse" | "error" | "aborted" } = {},
) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-completions",
    provider: "fake",
    model: "test",
    usage,
    stopReason: options.stopReason ?? "stop",
    timestamp: at,
    responseId: options.responseId,
  };
}

function ingest(store: OmpRuntimeStore, event: unknown, seq: number, fromHistory = false): void {
  store.ingest(event as ChatSessionEvent, seq, fromHistory);
}

function omp(store: OmpRuntimeStore, event: unknown, seq: number): void {
  ingest(store, { kind: "event", event }, seq);
}

describe("OmpRuntimeStore", () => {
  test("reduces streaming text/thinking and pairs same-millisecond endings by C0 identity", () => {
    const store = new OmpRuntimeStore({ threadId });
    const start = assistant("");
    const second = assistant("second", { responseId: "r2" });

    omp(store, { type: "agent_start" }, 1);
    omp(store, { type: "message_start", messageId: "m1", message: start }, 2);
    omp(
      store,
      {
        type: "message_update",
        messageId: "m1",
        message: { ...start, content: [{ type: "text", text: "hello" }] },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "hello",
          partial: { ...start, content: [{ type: "text", text: "hello" }] },
        },
      },
      3,
    );
    omp(store, { type: "message_end", messageId: "m1", message: assistant("hello") }, 4);
    omp(store, { type: "message_start", messageId: "m2", message: second }, 5);
    omp(store, { type: "message_end", messageId: "m2", message: second }, 6);

    const provisional = "stream:thread-r0:0:m1";
    const beforePair = store.getSnapshot();
    expect(
      beforePair.messages[provisional as keyof typeof beforePair.messages]?.message,
    ).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });
    expect(beforePair.pendingEnded).toEqual(["stream:thread-r0:0:m1", "stream:thread-r0:0:m2"]);

    store.pairEndedMessages([
      {
        type: "message",
        id: "entry-first",
        parentId: null,
        timestamp: new Date(at).toISOString(),
        message: assistant("different first"),
      },
      {
        type: "message",
        id: "entry-second",
        parentId: "entry-first",
        timestamp: new Date(at).toISOString(),
        message: second,
      },
    ]);

    const snapshot = store.getSnapshot();
    expect(snapshot.pendingEnded).toEqual([]);
    expect(snapshot.transcript.head).toBe("entry-second" as EntryId);
    expect(snapshot.messages["entry:thread-r0:entry-first"]).toMatchObject({
      status: "persisted",
      entryId: "entry-first",
      parentId: null,
    });
    expect(snapshot.messages["entry:thread-r0:entry-second"]).toMatchObject({
      status: "persisted",
      entryId: "entry-second",
      parentId: "entry-first",
    });
    expect(snapshot.messageOrder).toEqual([
      "entry:thread-r0:entry-first",
      "entry:thread-r0:entry-second",
    ]);

    const before = store.getSnapshot();
    expect(Object.isFrozen(before)).toBe(true);
    // The messages are a read-only view of chunks, so the record itself is not frozen: writes to it are refused.
    expect(() => {
      (before.messages as Record<string, unknown>).new = {};
    }).toThrow();
  });

  test("a streamed text block keeps each delta once when an update's snapshot runs ahead of it", () => {
    const store = new OmpRuntimeStore({ threadId });
    // Updates can reach the store together, so a snapshot can hold the text of deltas that come after its own.
    const ahead = assistant("alpha beta gamma");
    omp(store, { type: "agent_start" }, 1);
    omp(store, { type: "message_start", messageId: "m1", message: assistant("") }, 2);
    omp(
      store,
      {
        type: "message_update",
        messageId: "m1",
        message: ahead,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: ahead },
      },
      3,
    );
    ["alpha ", "beta ", "gamma"].forEach((delta, index) => {
      omp(
        store,
        {
          type: "message_update",
          messageId: "m1",
          message: ahead,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: ahead },
        },
        4 + index,
      );
    });
    const snapshot = store.getSnapshot();
    expect(
      snapshot.messages["stream:thread-r0:0:m1" as keyof typeof snapshot.messages]?.message,
    ).toMatchObject({
      content: [{ type: "text", text: "alpha beta gamma" }],
    });
  });

  test("a streamed message keeps its row key when history returns its entry, so the row is not replaced", () => {
    const store = new OmpRuntimeStore({ threadId });
    omp(store, { type: "agent_start" }, 1);
    omp(store, { type: "message_start", messageId: "m1", message: assistant("") }, 2);
    omp(store, { type: "message_end", messageId: "m1", message: assistant("hello") }, 3);

    store.pairEndedMessages([
      {
        type: "message",
        id: "entry-first",
        parentId: null,
        timestamp: new Date(at).toISOString(),
        message: assistant("hello"),
      },
    ]);

    const snapshot = store.getSnapshot();
    expect(snapshot.messageOrder).toEqual(["entry:thread-r0:entry-first"]);
    expect(snapshot.messages["entry:thread-r0:entry-first"]).toMatchObject({
      key: "entry:thread-r0:entry-first",
      status: "persisted",
      rowKey: "stream:thread-r0:0:m1",
    });
  });
  test("keeps thinking content in the provisional message while it streams", () => {
    const store = new OmpRuntimeStore({ threadId });
    const initial = assistant("");
    const thinking = {
      ...initial,
      content: [{ type: "thinking" as const, thinking: "reason" }],
    };
    omp(store, { type: "message_start", messageId: "thinking-1", message: initial }, 1);
    omp(
      store,
      {
        type: "message_update",
        messageId: "thinking-1",
        message: thinking,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "reason",
          partial: thinking,
        },
      },
      2,
    );
    expect(store.getSnapshot().streaming["stream:thread-r0:0:thinking-1"]).toMatchObject({
      message: { content: [{ type: "thinking", thinking: "reason" }] },
    });
  });
  test("isolates reused stream message ids across process generations", () => {
    const store = new OmpRuntimeStore({ threadId });
    const first = assistant("old");
    omp(store, { type: "message_start", messageId: "msg-1", message: first }, 1);
    const oldKey = "stream:thread-r0:0:msg-1" as ProvisionalMessageKey;
    let snapshot = store.getSnapshot();
    expect(snapshot.messages[oldKey as MessageKey]).toBeDefined();

    ingest(store, { kind: "process", status: "exited" }, 2);
    snapshot = store.getSnapshot();
    expect(snapshot.messages[oldKey as MessageKey]).toMatchObject({
      status: "ended",
      interrupted: true,
    });
    expect(snapshot.streaming[oldKey]).toBeUndefined();

    ingest(store, { kind: "process", status: "starting" }, 3);
    expect(store.getSnapshot()).toMatchObject({
      processGeneration: 1,
      processId: "thread-r0:1",
    });
    omp(store, { type: "message_start", messageId: "msg-1", message: assistant("new") }, 4);
    const newKey = "stream:thread-r0:1:msg-1" as ProvisionalMessageKey;
    snapshot = store.getSnapshot();
    expect(snapshot.messages[newKey as MessageKey]).toMatchObject({
      status: "streaming",
      message: { content: [{ type: "text", text: "new" }] },
    });
    expect(snapshot.messages[oldKey as MessageKey]).toMatchObject({ interrupted: true });
  });

  test("an answer cut off by the process exiting keeps its own place and never takes a later answer's", () => {
    const store = new OmpRuntimeStore({ threadId });
    const ask = (text: string, stamp: number) => ({
      role: "user",
      content: text,
      timestamp: at + stamp,
    });
    const reply = (text: string, stamp: number) => ({ ...assistant(text), timestamp: at + stamp });
    let seq = 0;
    const nextSeq = (): number => {
      seq += 1;
      return seq;
    };
    const live = (event: unknown): void => omp(store, event, nextSeq());
    const processStatus = (status: string): void =>
      ingest(store, { kind: "process", status }, nextSeq());

    // A finished turn, then a turn whose answer is cut off while it streams: omp is killed.
    live({ type: "agent_start" });
    live({ type: "message_start", message: ask("first", 1) });
    live({ type: "message_end", message: ask("first", 1) });
    live({ type: "message_start", message: reply("", 2) });
    live({ type: "message_end", message: reply("pong", 2) });
    live({ type: "agent_end" });
    live({ type: "agent_start" });
    live({ type: "message_start", message: ask("long please", 3) });
    live({ type: "message_end", message: ask("long please", 3) });
    live({ type: "message_start", message: reply("", 4) });
    const partial = reply("cut off text", 4);
    live({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "cut off text",
        partial,
      },
    });
    processStatus("exited");
    processStatus("starting");
    processStatus("ready");
    // The next turn, after Restart omp.
    live({ type: "agent_start" });
    live({ type: "message_start", message: ask("ping", 5) });
    live({ type: "message_end", message: ask("ping", 5) });
    live({ type: "message_start", message: reply("", 6) });
    live({ type: "message_end", message: reply("pong", 6) });
    live({ type: "agent_end" });

    // omp's file holds every message except the one that was cut off.
    const entry = (id: string, parentId: string | null, message: unknown) => ({
      type: "message",
      id,
      parentId,
      timestamp: new Date(at).toISOString(),
      message,
    });
    store.pairEndedMessages(
      [
        entry("u1", null, ask("first", 1)),
        entry("a1", "u1", reply("pong", 2)),
        entry("u2", "a1", ask("long please", 3)),
        entry("u3", "u2", ask("ping", 5)),
        entry("a3", "u3", reply("pong", 6)),
      ],
      "a3" as EntryId,
    );

    const snapshot = store.getSnapshot();
    const shown = snapshot.messageOrder.map((key) => {
      const message = snapshot.messages[key]?.message as
        | { role: string; content: unknown }
        | undefined;
      const content = message?.content;
      const text = Array.isArray(content)
        ? content.map((part: { text?: string }) => part.text ?? "").join("")
        : String(content);
      return `${message?.role}: ${text}`;
    });
    expect(shown).toEqual([
      "user: first",
      "assistant: pong",
      "user: long please",
      "assistant: cut off text",
      "user: ping",
      "assistant: pong",
    ]);
  });

  test("cancels active tools on abort, settlement, and process exit", () => {
    const aborted = new OmpRuntimeStore({ threadId });
    omp(aborted, { type: "tool_execution_start", toolCallId: "abort-tool", toolName: "bash" }, 1);
    ingest(
      aborted,
      promptResultEvent({
        type: "prompt_result",
        agentInvoked: true,
        status: "aborted",
        sessionSettled: false,
      }),
      2,
    );
    expect(aborted.getSnapshot().tools["abort-tool" as ToolCallId]?.status).toBe("cancelled");

    const settled = new OmpRuntimeStore({ threadId });
    omp(settled, { type: "tool_execution_start", toolCallId: "partial-tool", toolName: "bash" }, 1);
    omp(
      settled,
      {
        type: "tool_execution_update",
        toolCallId: "partial-tool",
        toolName: "bash",
        partialResult: "part",
      },
      2,
    );
    ingest(settled, { kind: "event", event: { type: "session_settled" } }, 3);
    expect(settled.getSnapshot().tools["partial-tool" as ToolCallId]).toMatchObject({
      status: "cancelled",
      partialResult: "part",
    });

    const exited = new OmpRuntimeStore({ threadId });
    omp(exited, { type: "tool_execution_start", toolCallId: "exit-tool", toolName: "bash" }, 1);
    ingest(exited, { kind: "process", status: "exited" }, 2);
    expect(exited.getSnapshot().tools["exit-tool" as ToolCallId]?.status).toBe("cancelled");
  });

  test("bounds prompt result history and exposes one queue/todo name", () => {
    const store = new OmpRuntimeStore({ threadId });
    for (let index = 1; index <= 25; index += 1) {
      ingest(
        store,
        promptResultEvent({
          type: "prompt_result",
          agentInvoked: true,
          status: "completed",
          sessionSettled: false,
          id: `prompt-${index}`,
        }),
        index,
      );
    }
    expect(store.getSnapshot().prompt.promptResults).toHaveLength(20);
    expect(store.getSnapshot().prompt.promptResults[0]?.id).toBe("prompt-6");
    expect(store.getSnapshot().prompt.promptResults[19]?.id).toBe("prompt-25");
    expect("queues" in store.getSnapshot()).toBe(false);
    expect("todos" in store.getSnapshot()).toBe(false);
  });

  test("keeps tool calls correlated when completions arrive out of order", () => {
    const store = new OmpRuntimeStore({ threadId });
    omp(
      store,
      { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a" } },
      1,
    );
    omp(
      store,
      { type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "b" } },
      2,
    );
    omp(
      store,
      { type: "tool_execution_update", toolCallId: "a", toolName: "read", partialResult: "part-a" },
      3,
    );
    omp(
      store,
      { type: "tool_stream_update", toolCallId: "b", toolName: "read", update: "part-b" },
      4,
    );
    omp(
      store,
      { type: "tool_execution_end", toolCallId: "b", toolName: "read", result: "done-b" },
      5,
    );
    omp(
      store,
      {
        type: "tool_execution_end",
        toolCallId: "a",
        toolName: "read",
        result: "failed-a",
        isError: true,
      },
      6,
    );

    expect(store.getSnapshot().tools["a" as ToolCallId]).toMatchObject({
      status: "error",
      result: "failed-a",
      isError: true,
    });
    expect(store.getSnapshot().tools["b" as ToolCallId]).toMatchObject({
      status: "success",
      result: "done-b",
    });
    expect(store.getSnapshot().tools["a" as ToolCallId]?.partialResult).toBe("part-a");
    expect(store.getSnapshot().tools["b" as ToolCallId]?.streamProjection).toBe("part-b");
  });

  test("keeps only the latest partial result and argument projection of a tool", () => {
    const store = new OmpRuntimeStore({ threadId });
    const event = (type: string, extra: Record<string, unknown>) => ({
      type,
      toolCallId: "t",
      toolName: "edit",
      ...extra,
    });
    omp(store, event("tool_stream_update", { update: { diff: "1" } }), 1);
    omp(store, event("tool_stream_update", { update: { diff: "12" } }), 2);
    omp(store, event("tool_execution_start", { args: { path: "f" } }), 3);
    omp(store, event("tool_execution_update", { partialResult: "out 1" }), 4);
    omp(store, event("tool_execution_update", { partialResult: "out 1 2" }), 5);
    omp(store, event("tool_execution_end", { result: "done" }), 6);
    expect(store.getSnapshot().tools["t" as ToolCallId]).toMatchObject({
      status: "success",
      partialResult: "out 1 2",
      streamProjection: { diff: "12" },
      result: "done",
    });
  });

  test("a late tool update keeps an ended call's state through the turn's settle, and records its progress", () => {
    const store = new OmpRuntimeStore({ threadId });
    const event = (type: string, extra: Record<string, unknown>) => ({
      type,
      toolName: "task",
      ...extra,
    });
    omp(store, event("tool_execution_start", { toolCallId: "done" }), 1);
    omp(store, event("tool_execution_end", { toolCallId: "done", result: "spawned" }), 2);
    omp(store, event("tool_execution_start", { toolCallId: "failed" }), 3);
    omp(
      store,
      event("tool_execution_end", { toolCallId: "failed", result: "boom", isError: true }),
      4,
    );
    // omp's worker reports after both calls returned, while the turn still runs: they keep their ended state.
    omp(
      store,
      event("tool_execution_update", { toolCallId: "done", partialResult: "worker done" }),
      5,
    );
    omp(
      store,
      event("tool_execution_update", { toolCallId: "failed", partialResult: "worker failed" }),
      6,
    );
    expect(store.getSnapshot().tools["done" as ToolCallId]).toMatchObject({
      status: "success",
      partialResult: "worker done",
      result: "spawned",
    });
    expect(store.getSnapshot().tools["failed" as ToolCallId]).toMatchObject({
      status: "error",
      partialResult: "worker failed",
      result: "boom",
      isError: true,
    });
    ingest(store, { kind: "event", event: { type: "session_settled" } }, 7);
    expect(store.getSnapshot().tools["done" as ToolCallId]).toMatchObject({ status: "success" });
    expect(store.getSnapshot().tools["failed" as ToolCallId]).toMatchObject({ status: "error" });

    // A call the settle already cancelled stays cancelled when a late update arrives: the turn is over.
    omp(store, event("tool_execution_start", { toolCallId: "cut" }), 8);
    ingest(store, { kind: "event", event: { type: "session_settled" } }, 9);
    omp(store, event("tool_execution_update", { toolCallId: "cut", partialResult: "late" }), 10);
    expect(store.getSnapshot().tools["cut" as ToolCallId]).toMatchObject({ status: "cancelled" });
  });

  test("follows the todo tool like omp: successful results other than view replace the phases", () => {
    const store = new OmpRuntimeStore({ threadId });
    const phases = [{ name: "Build", tasks: [{ content: "write", status: "completed" }] }];
    const end = (seq: number, details: Record<string, unknown>, isError = false) =>
      omp(
        store,
        {
          type: "tool_execution_end",
          toolCallId: `todo-${seq}`,
          toolName: "todo",
          result: { content: [], details },
          isError,
        },
        seq,
      );
    end(1, { op: "replace", phases });
    expect(store.getSnapshot().todoPhases).toEqual(phases);
    end(2, { op: "view", phases: [] });
    end(3, { op: "replace", phases: [] }, true);
    end(4, { op: "replace" });
    expect(store.getSnapshot().todoPhases).toEqual(phases);
  });

  test("records todo reminders as bounded transcript panels without touching the todo state", () => {
    const store = new OmpRuntimeStore({ threadId });
    const phases = [
      {
        name: "Build",
        tasks: [
          { content: "a", status: "completed" },
          { content: "b", status: "pending" },
        ],
      },
    ];
    omp(
      store,
      {
        type: "tool_execution_end",
        toolCallId: "t",
        toolName: "todo",
        result: { content: [], details: { op: "replace", phases } },
      },
      1,
    );
    for (let seq = 2; seq <= 23; seq += 1) {
      omp(
        store,
        {
          type: "todo_reminder",
          todos: [{ content: "b", status: "pending" }],
          attempt: seq - 1,
          maxAttempts: 30,
        },
        seq,
      );
    }
    const snapshot = store.getSnapshot();
    expect(snapshot.todoPhases).toEqual(phases);
    expect(snapshot.todoReminders).toHaveLength(20);
    expect(snapshot.todoReminders.at(-1)).toMatchObject({
      attempt: 22,
      maxAttempts: 30,
      afterMessage: null,
    });
  });

  test("a todo reminder follows the row of the newest message, and that row keeps its id once the message is saved", () => {
    const store = new OmpRuntimeStore({ threadId });
    omp(store, { type: "agent_start" }, 1);
    omp(store, { type: "message_start", messageId: "m1", message: assistant("") }, 2);
    omp(store, { type: "message_end", messageId: "m1", message: assistant("hello") }, 3);
    const row = "stream:thread-r0:0:m1";
    omp(
      store,
      {
        type: "todo_reminder",
        todos: [{ content: "b", status: "pending" }],
        attempt: 1,
        maxAttempts: 3,
      },
      4,
    );
    expect(store.getSnapshot().todoReminders.at(-1)?.afterMessage).toBe(row);

    store.pairEndedMessages([
      {
        type: "message",
        id: "entry-first",
        parentId: null,
        timestamp: new Date(at).toISOString(),
        message: assistant("hello"),
      },
    ]);
    expect(store.getSnapshot().messageOrder).toEqual(["entry:thread-r0:entry-first"]);
    expect(store.getSnapshot().todoReminders.at(-1)?.afterMessage).toBe(row);
  });

  test("a todo reminder after a tool result names the answer that called the tool, so that answer's row is the one that closes", () => {
    const store = new OmpRuntimeStore({ threadId });
    omp(store, { type: "agent_start" }, 1);
    const calling = assistant("I will check the todos.", { stopReason: "toolUse" });
    omp(store, { type: "message_start", messageId: "m1", message: calling }, 2);
    omp(store, { type: "message_end", messageId: "m1", message: calling }, 3);
    const result = {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "todo",
      content: [{ type: "text" as const, text: "Updated todos" }],
      isError: false,
      timestamp: at,
    };
    omp(store, { type: "message_start", messageId: "m2", message: result }, 4);
    omp(store, { type: "message_end", messageId: "m2", message: result }, 5);
    omp(
      store,
      {
        type: "todo_reminder",
        todos: [{ content: "b", status: "pending" }],
        attempt: 1,
        maxAttempts: 3,
      },
      6,
    );
    expect(store.getSnapshot().todoReminders.at(-1)?.afterMessage).toBe("stream:thread-r0:0:m1");
  });

  test("a streamed copy that takes the place of a message the history shows keeps that message's row, so a reminder on it still follows it", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.pairEndedMessages([
      {
        type: "message",
        id: "entry-shown",
        parentId: null,
        timestamp: new Date(at).toISOString(),
        message: assistant("hello"),
      },
    ]);
    const shownRow = "entry:thread-r0:entry-shown";
    omp(store, { type: "agent_start" }, 1);
    omp(
      store,
      {
        type: "todo_reminder",
        todos: [{ content: "b", status: "pending" }],
        attempt: 1,
        maxAttempts: 3,
      },
      2,
    );
    expect(store.getSnapshot().todoReminders.at(-1)?.afterMessage).toBe(shownRow);
    // The stream replays the same message: it takes the shown message's place in the transcript.
    omp(store, { type: "message_start", messageId: "m1", message: assistant("hello") }, 3);
    const snapshot = store.getSnapshot();
    const rows = snapshot.messageOrder.flatMap((key) => {
      const record = snapshot.messages[key];
      return record === undefined ? [] : [rowIdOf(record)];
    });
    expect(rows).toEqual([shownRow]);
    expect(rows).toContain(snapshot.todoReminders.at(-1)?.afterMessage);
  });

  test("shares unchanged state between snapshots and freezes what changed", () => {
    const store = new OmpRuntimeStore({ threadId });
    const start = (id: string, seq: number) =>
      omp(
        store,
        { type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: id } },
        seq,
      );
    start("a", 1);
    const before = store.getSnapshot();
    start("b", 2);
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.transcript).toBe(before.transcript);
    expect(after.tools["a" as ToolCallId]).toBe(before.tools["a" as ToolCallId]);
    expect(() => {
      (after.tools as Record<string, unknown>).new = {};
    }).toThrow();
    expect(Object.isFrozen(after.tools["b" as ToolCallId])).toBe(true);
  });

  test("keeps prompt_result and session_settled distinct, including abort", () => {
    const store = new OmpRuntimeStore({ threadId });
    omp(store, { type: "agent_start" }, 1);
    ingest(
      store,
      promptResultEvent({
        type: "prompt_result",
        agentInvoked: true,
        status: "aborted",
        sessionSettled: false,
        id: "p1",
      }),
      2,
    );
    expect(store.getSnapshot().prompt).toMatchObject({
      admitted: true,
      streaming: false,
      promptResult: { status: "aborted", sessionSettled: false, id: "p1" },
      sessionSettled: false,
    });

    ingest(store, { kind: "event", event: { type: "session_settled" } }, 3);
    expect(store.getSnapshot().prompt).toMatchObject({ sessionSettled: true });
    expect(store.getSnapshot().prompt.promptResult).toMatchObject({ status: "aborted" });
    ingest(
      store,
      {
        kind: "process",
        status: "error",
        error: { code: "omp_error", message: "provider failed", retryable: true },
      },
      4,
    );
    expect(store.getSnapshot().error).toEqual({
      code: "omp_error",
      message: "provider failed",
      retryable: true,
    });
  });
  test("a run that starts clears the error an earlier prompt reported, but not the process's own failure", () => {
    const store = new OmpRuntimeStore({ threadId });
    omp(store, { type: "agent_start" }, 1);
    ingest(
      store,
      promptResultEvent({
        type: "prompt_result",
        agentInvoked: true,
        status: "error",
        sessionSettled: true,
        id: "p1",
        error: { message: "400 fake provider failure", retryable: false, httpStatus: 400 },
      }),
      2,
    );
    expect(store.getSnapshot().error).toMatchObject({
      code: "omp_error",
      message: "400 fake provider failure",
    });

    // A later prompt is accepted: the conversation goes on, so the earlier failure no longer shows.
    omp(store, { type: "agent_start" }, 3);
    expect(store.getSnapshot().error).toBeNull();

    // The process's own failure stays until the process is ready again.
    ingest(store, { kind: "process", status: "exited" }, 4);
    expect(store.getSnapshot().error).toMatchObject({ code: "omp_exited" });
    omp(store, { type: "agent_start" }, 5);
    expect(store.getSnapshot().error).toMatchObject({ code: "omp_exited" });
  });
  test("forwards selected raw notifications in order and deduplicates sequence replays", () => {
    const store = new OmpRuntimeStore({ threadId });
    const lifecycle = { type: "subagent_lifecycle", payload: { id: "a", status: "started" } };
    const progress = { type: "subagent_progress", payload: { id: "a", progress: 1 } };
    const command = { type: "command_output", text: "output" };
    const received: Array<{ type: string; seq: number; frame: unknown }> = [];
    const other: string[] = [];
    const unsubscribe = store.subscribeNotifications(
      ["subagent_lifecycle", "subagent_progress"],
      (frame, seq) => received.push({ type: frame.type, seq, frame }),
    );
    const unsubscribeOther = store.subscribeNotifications(["command_output"], (frame) => {
      other.push(frame.type);
    });

    ingest(store, notificationEvent(lifecycle), 1);
    ingest(store, notificationEvent(progress), 2);
    ingest(store, notificationEvent(command), 3);
    ingest(store, notificationEvent(progress), 2);

    expect(received).toEqual([
      { type: "subagent_lifecycle", seq: 1, frame: lifecycle },
      { type: "subagent_progress", seq: 2, frame: progress },
    ]);
    expect(other).toEqual(["command_output"]);
    unsubscribe();
    unsubscribeOther();
    ingest(store, notificationEvent(lifecycle), 4);
    expect(received).toHaveLength(2);
    expect(other).toEqual(["command_output"]);
  });

  describe("goal_updated", () => {
    const goal = (status: string, tokensUsed = 0) => ({
      id: "g1",
      objective: "Ship the release",
      status,
      tokensUsed,
      timeUsedSeconds: 0,
      createdAt: at,
      updatedAt: at,
    });

    test("session.goal follows the goal omp announces, with the mode when omp sends one", () => {
      const store = new OmpRuntimeStore({ threadId });
      expect(store.getSnapshot().session.goal).toBeNull();
      const created = { enabled: true, mode: "active", goal: goal("active") };
      ingest(
        store,
        notificationEvent({ type: "goal_updated", goal: goal("active"), state: created }),
        1,
      );
      expect(store.getSnapshot().session.goal).toEqual(created);
      // omp pauses a goal by setting enabled to false: the store keeps that, it does not guess.
      const paused = { enabled: false, mode: "active", goal: goal("paused") };
      ingest(
        store,
        notificationEvent({ type: "goal_updated", goal: goal("paused"), state: paused }),
        2,
      );
      expect(store.getSnapshot().session.goal).toEqual(paused);
    });

    test("an update with no mode keeps the mode and replaces the goal; a dropped goal clears it", () => {
      const store = new OmpRuntimeStore({ threadId });
      const created = { enabled: true, mode: "active", goal: goal("active") };
      ingest(
        store,
        notificationEvent({ type: "goal_updated", goal: goal("active"), state: created }),
        1,
      );
      ingest(store, notificationEvent({ type: "goal_updated", goal: goal("active", 1200) }), 2);
      expect(store.getSnapshot().session.goal).toEqual({ ...created, goal: goal("active", 1200) });
      ingest(store, notificationEvent({ type: "goal_updated", goal: null }), 3);
      expect(store.getSnapshot().session.goal).toBeNull();
    });

    test("an update with no mode and no mode held leaves the goal unset, and a replayed sequence is applied once", () => {
      const store = new OmpRuntimeStore({ threadId });
      ingest(store, notificationEvent({ type: "goal_updated", goal: goal("active") }), 1);
      expect(store.getSnapshot().session.goal).toBeNull();
      const created = { enabled: true, mode: "active", goal: goal("active") };
      ingest(
        store,
        notificationEvent({ type: "goal_updated", goal: goal("active"), state: created }),
        2,
      );
      const revision = store.getSnapshot().session.revision;
      ingest(
        store,
        notificationEvent({ type: "goal_updated", goal: goal("active"), state: created }),
        2,
      );
      expect(store.getSnapshot().session.revision).toBe(revision);
    });
  });

  test("forwards only applied Omp events with their sequence after commit", () => {
    const store = new OmpRuntimeStore({ threadId });
    const received: Array<{ type: string; seq: number; committedSeq: number }> = [];
    const starts: number[] = [];
    const unsubscribe = store.subscribeOmpEvents(undefined, (event, seq) => {
      received.push({ type: event.type, seq, committedSeq: store.getSnapshot().lastSeq });
    });
    const unsubscribeStarts = store.subscribeOmpEvents(["agent_start"], (_event, seq) => {
      starts.push(seq);
    });

    omp(store, { type: "agent_start" }, 1);
    omp(store, { type: "agent_end" }, 2);
    ingest(store, notificationEvent({ type: "command_output", text: "output" }), 3);
    omp(store, { type: "agent_start" }, 2);
    omp(store, { type: "agent_start" }, 5);

    expect(received).toEqual([
      { type: "agent_start", seq: 1, committedSeq: 1 },
      { type: "agent_end", seq: 2, committedSeq: 2 },
    ]);
    expect(starts).toEqual([1]);
    expect(store.getSnapshot().needsRefetch).toBe(true);

    unsubscribe();
    unsubscribeStarts();
    store.resetSequence();
    omp(store, { type: "agent_end" }, 6);
    expect(received).toHaveLength(2);
  });

  test("tracks queues, modes, todos, pending dialogs, and answers", async () => {
    const calls: unknown[] = [];
    const setTodoCalls: unknown[] = [];
    const store = new OmpRuntimeStore({
      threadId,
      transport: {
        answer: async (args) => {
          calls.push(args);
          return null;
        },
        send: async (args) => {
          setTodoCalls.push(args);
          return {
            todoPhases: [{ name: "main", tasks: [{ content: "server", status: "pending" }] }],
          };
        },
      },
    });
    omp(store, { type: "queue_update", steering: ["steer me"], followUp: ["later"] }, 1);
    store.applySessionState({
      steeringMode: "one-at-a-time",
      followUpMode: "all",
      interruptMode: "wait",
      todoPhases: [{ name: "main", tasks: [{ content: "ship", status: "in_progress" }] }],
      isStreaming: true,
      isSettled: false,
    });
    expect(store.getSnapshot().queue).toMatchObject({
      steering: ["steer me"],
      followUp: ["later"],
      steeringMode: "one-at-a-time",
      interruptMode: "wait",
    });
    await store.setTodos([{ name: "main", tasks: [{ content: "client", status: "pending" }] }]);
    expect(setTodoCalls[0]).toMatchObject({
      threadId,
      command: { type: "set_todos", phases: [{ name: "main" }] },
    });
    expect(store.getSnapshot().todoPhases).toEqual([
      { name: "main", tasks: [{ content: "server", status: "pending" }] },
    ]);

    // A reminder is a transcript panel; the todo state stays what the todo tool or set_todos said.
    omp(store, { type: "todo_reminder", todos: [{ content: "server", status: "pending" }] }, 2);
    expect(store.getSnapshot().todoPhases).toEqual([
      { name: "main", tasks: [{ content: "server", status: "pending" }] },
    ]);
    expect(store.getSnapshot().todoReminders).toHaveLength(1);
    omp(store, { type: "todo_auto_clear" }, 3);
    expect(store.getSnapshot().todoPhases).toEqual([]);

    ingest(
      store,
      dialogEvent({
        id: "ui-1",
        method: "ui.confirm",
        params: { title: "Continue?", message: "yes" },
      }),
      4,
    );
    expect(store.getSnapshot().pending.dialogs["ui-1"]?.request).toMatchObject({
      method: "ui.confirm",
      params: { title: "Continue?" },
    });
    await store.answerDialog("ui-1", { confirmed: true });
    expect(store.getSnapshot().pending.dialogs).toEqual({});
    expect(calls).toEqual([{ threadId, id: "ui-1", answer: { confirmed: true } }]);
  });

  test("omp's exit drops the dialogs it asked, since it can no longer answer them", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, { kind: "process", status: "ready" }, 1);
    ingest(
      store,
      dialogEvent({
        id: "ui-open",
        method: "ui.confirm",
        params: { title: "Continue?", message: "yes" },
      }),
      2,
    );
    expect(Object.keys(store.getSnapshot().pending.dialogs)).toEqual(["ui-open"]);
    ingest(
      store,
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      },
      3,
    );
    expect(store.getSnapshot().pending.dialogs).toEqual({});
    expect(store.getSnapshot().error).toMatchObject({ message: "omp exited (signal SIGKILL)" });
  });

  test("an answer that fails because omp exited first leaves the exit reason on the banner", async () => {
    const answered = Promise.withResolvers<void>();
    const store = new OmpRuntimeStore({
      threadId,
      transport: {
        answer: async () => {
          await answered.promise;
          throw new AppFailure({
            code: "not_found",
            message: "No pending extension UI request",
            retryable: false,
          });
        },
      },
    });
    ingest(store, { kind: "process", status: "ready" }, 1);
    ingest(
      store,
      dialogEvent({
        id: "ui-late",
        method: "ui.confirm",
        params: { title: "Continue?", message: "yes" },
      }),
      2,
    );
    const answer = store.answerDialog("ui-late", { confirmed: true });
    ingest(
      store,
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      },
      3,
    );
    answered.resolve();
    await expect(answer).rejects.toMatchObject({ appError: { code: "not_found" } });
    expect(store.getSnapshot().error).toMatchObject({
      code: "omp_exited",
      message: "omp exited (signal SIGKILL)",
    });
  });

  test("a failed answer is thrown to the dialog and leaves the thread's banner clear, also after a retry (issue 1386)", async () => {
    let attempts = 0;
    const store = new OmpRuntimeStore({
      threadId,
      transport: {
        answer: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new AppFailure({
              code: "omp_exited",
              message: "The omp RPC transport closed",
              retryable: true,
            });
          }
          return null;
        },
      },
    });
    ingest(store, { kind: "process", status: "ready" }, 1);
    ingest(
      store,
      dialogEvent({
        id: "ui-failed",
        method: "ui.confirm",
        params: { title: "Continue?", message: "yes" },
      }),
      2,
    );
    await expect(store.answerDialog("ui-failed", { confirmed: true })).rejects.toMatchObject({
      appError: { code: "omp_exited", message: "The omp RPC transport closed" },
    });
    expect(store.getSnapshot().error).toBeNull();
    expect(Object.keys(store.getSnapshot().pending.dialogs)).toEqual(["ui-failed"]);

    await store.answerDialog("ui-failed", { confirmed: true });
    expect(store.getSnapshot().error).toBeNull();
    expect(store.getSnapshot().pending.dialogs).toEqual({});
  });
  test("a not-found answer keeps the store entry but leaves the conversation banner clear", async () => {
    const store = new OmpRuntimeStore({
      threadId,
      transport: {
        answer: async () => {
          throw new AppFailure({
            code: "not_found",
            message: "No pending extension UI request",
            retryable: false,
          });
        },
      },
    });
    ingest(store, { kind: "process", status: "ready" }, 1);
    ingest(
      store,
      dialogEvent({
        id: "ui-gone",
        method: "ui.confirm",
        params: { title: "Continue?", message: "yes" },
      }),
      2,
    );

    await expect(store.answerDialog("ui-gone", { confirmed: true })).rejects.toMatchObject({
      appError: { code: "not_found", message: "No pending extension UI request" },
    });
    expect(Object.keys(store.getSnapshot().pending.dialogs)).toEqual(["ui-gone"]);
    expect(store.getSnapshot().error).toBeNull();
  });

  test("ignores unknown notifications, replays, and events after a sequence gap", () => {
    const store = new OmpRuntimeStore({ threadId });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    ingest(store, notificationEvent({ type: "future_notification", payload: { x: 1 } }), 1);
    expect(store.getSnapshot().lastSeq).toBe(1);
    const revision = store.getSnapshot().revision;
    ingest(store, notificationEvent({ type: "future_notification", payload: { x: 2 } }), 1);
    expect(store.getSnapshot().revision).toBe(revision);

    ingest(store, { kind: "process", status: "ready" }, 3);
    expect(store.getSnapshot()).toMatchObject({ lastSeq: 1, needsRefetch: true });
    ingest(store, { kind: "process", status: "running" }, 4);
    expect(store.getSnapshot()).toMatchObject({
      lastSeq: 1,
      needsRefetch: true,
      process: { status: "starting" },
    });
    store.resetSequence(3);
    ingest(store, { kind: "process", status: "running" }, 4);
    expect(store.getSnapshot()).toMatchObject({
      lastSeq: 4,
      needsRefetch: false,
      process: { status: "running" },
    });
    unsubscribe();
    expect(notifications).toBeGreaterThan(0);
  });

  test("a process frame's start time is kept until a frame says when its own process started", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, { kind: "process", status: "starting", startedAt: 1_000 }, 1);
    expect(store.getSnapshot().process).toEqual({
      status: "starting",
      error: null,
      startedAt: 1_000,
    });
    ingest(store, { kind: "process", status: "ready", startedAt: 1_000 }, 2);
    // A frame that says nothing of its start keeps the time the last one gave.
    ingest(store, { kind: "process", status: "running" }, 3);
    expect(store.getSnapshot().process).toEqual({
      status: "running",
      error: null,
      startedAt: 1_000,
    });
    // Another process says its own start.
    ingest(store, { kind: "process", status: "exited", startedAt: 1_000 }, 4);
    ingest(store, { kind: "process", status: "starting", startedAt: 2_000 }, 5);
    expect(store.getSnapshot().process).toEqual({
      status: "starting",
      error: null,
      startedAt: 2_000,
    });
  });

  test("resumes after a refetch where the stream really is, including on a fresh store", () => {
    const store = new OmpRuntimeStore({ threadId });
    // A new viewer joins a stream that is already past seq 1041: the first event is a gap.
    ingest(store, { kind: "process", status: "ready" }, 1042);
    expect(store.getSnapshot().needsRefetch).toBe(true);
    // Events keep arriving while history loads: dropped, but their seq is remembered.
    ingest(store, { kind: "process", status: "running" }, 1043);
    store.resetSequence();
    expect(store.getSnapshot()).toMatchObject({ lastSeq: 1043, needsRefetch: false });
    ingest(store, { kind: "process", status: "running" }, 1044);
    expect(store.getSnapshot()).toMatchObject({ lastSeq: 1044, needsRefetch: false });
  });

  test("records a dialog omp is waiting on even across a gap or a refetch in flight", () => {
    const store = new OmpRuntimeStore({ threadId });
    const ask = (id: string, seq: number) =>
      ingest(
        store,
        dialogEvent({ id, method: "ui.confirm", params: { title: "Go on?", message: "" } }),
        seq,
      );
    // A fresh chat's first events predate the browser's subscription, so the first one it sees is
    // seq 6: a gap, and every ordinary event is dropped until history is refetched.
    ingest(store, { kind: "process", status: "ready" }, 6);
    expect(store.getSnapshot()).toMatchObject({ lastSeq: 0, needsRefetch: true });

    // omp asks a question while the refetch is running. The refetch restores messages and state but
    // never this, so the request must be kept or omp waits forever for an answer nobody was shown.
    ask("ask-1", 7);
    expect(store.getSnapshot().pending.dialogs["ask-1"]?.request).toMatchObject({
      method: "ui.confirm",
    });
    // Ordinary events in the gap are still dropped: the refetch covers them.
    ingest(store, { kind: "process", status: "running" }, 8);
    expect(store.getSnapshot()).toMatchObject({
      lastSeq: 0,
      needsRefetch: true,
      process: { status: "starting" },
    });

    // The host giving a dialog up inside the gap removes it, and a later one is recorded too.
    ingest(store, dialogCancelEvent("ask-1"), 9);
    expect(store.getSnapshot().pending.dialogs).toEqual({});
    ask("ask-2", 10);

    // Ending the gap moves the cursor and leaves the pending request alone.
    store.resetSequence();
    expect(store.getSnapshot()).toMatchObject({ lastSeq: 10, needsRefetch: false });
    expect(Object.keys(store.getSnapshot().pending.dialogs)).toEqual(["ask-2"]);
  });

  test("a notification the passthrough does not reduce reaches its subscriber across a gap, once", () => {
    const store = new OmpRuntimeStore({ threadId });
    const heard: Array<{ type: string; seq: number; replayed: boolean }> = [];
    store.subscribeNotifications(
      ["subagent_lifecycle", "subagent_progress"],
      (frame, seq, replayed) => {
        heard.push({ type: frame.type, seq, replayed });
      },
    );
    const started = { type: "subagent_lifecycle", payload: { id: "worker-1", status: "started" } };
    const ended = { type: "subagent_lifecycle", payload: { id: "worker-1", status: "completed" } };
    ingest(store, notificationEvent(started), 1);
    // Seq 2 never arrives, so the worker's end falls inside a gap: no refetch restores a worker's end.
    ingest(store, notificationEvent(ended), 3);
    expect(store.getSnapshot()).toMatchObject({ lastSeq: 1, needsRefetch: true });
    expect(heard).toEqual([
      { type: "subagent_lifecycle", seq: 1, replayed: false },
      { type: "subagent_lifecycle", seq: 3, replayed: false },
    ]);
    // A replay that sends the end again does not deliver it twice.
    ingest(store, notificationEvent(ended), 3);
    expect(heard).toHaveLength(2);
    // The refetch ends, the stream carries on, and later passthrough notifications are delivered as before.
    store.resetSequence();
    ingest(
      store,
      notificationEvent({ type: "subagent_progress", payload: { id: "worker-2", progress: 1 } }),
      4,
    );
    expect(heard).toHaveLength(3);
    expect(heard[2]).toEqual({ type: "subagent_progress", seq: 4, replayed: false });
  });
  test("does not forward a gap notification again when replay catches up from a lower cursor", () => {
    const store = new OmpRuntimeStore({ threadId });
    const heard: number[] = [];
    store.subscribeNotifications(["subagent_lifecycle"], (_frame, seq) => {
      heard.push(seq);
    });
    const ended = { type: "subagent_lifecycle", payload: { id: "worker-1", status: "completed" } };

    ingest(store, { kind: "process", status: "ready" }, 1);
    ingest(store, notificationEvent(ended), 3);
    expect(heard).toEqual([3]);

    store.resetSequence(0);
    ingest(store, { kind: "process", status: "ready" }, 1);
    ingest(store, { kind: "process", status: "running" }, 2);
    ingest(store, notificationEvent(ended), 3);

    expect(heard).toEqual([3]);
  });

  /** A forwarded frame by what it is: a dialog by its request's id, a notice by its words, anything else by its id or type. */
  function frameKey(routed: unknown): string {
    const frame = routed as { readonly type: string } & Record<string, unknown>;
    if (frame.type === "host_dialog") return String((frame.request as { id: string }).id);
    if (frame.type === "ui_notify") return `notice: ${String(frame.message)}`;
    return "id" in frame ? String(frame.id) : frame.type;
  }

  test("across a gap, a dialog is recorded but kept from its listeners, and the host's cancel drops it", () => {
    const store = new OmpRuntimeStore({ threadId });
    const routed: string[] = [];
    store.subscribeNotifications(["host_dialog"], (frame) => {
      routed.push(frameKey(frame));
    });
    // A fresh chat's first event is a gap: the dialog and its cancel both arrive inside it.
    ingest(store, { kind: "process", status: "ready" }, 6);
    ingest(
      store,
      dialogEvent({ id: "ask-1", method: "ui.confirm", params: { title: "Go on?", message: "" } }),
      7,
    );
    expect(store.getSnapshot().pending.dialogs["ask-1"]?.request).toMatchObject({
      method: "ui.confirm",
    });
    expect(routed).toEqual([]);
    ingest(store, dialogCancelEvent("ask-1"), 8);
    expect(store.getSnapshot().pending.dialogs).toEqual({});
    expect(routed).toEqual([]);
  });

  test("a dialog, host call or sign-in page from the history is not asked again, and a live one is", () => {
    const store = new OmpRuntimeStore({ threadId });
    const notified: string[] = [];
    store.subscribeNotifications(
      ["host_dialog", "host_call", "ui_open_url", "ui_notify"],
      (frame) => notified.push(frameKey(frame)),
    );
    // What a subscription from the start replays: a dialog that was answered, a tool call and a URI read whose turns
    // ended, a sign-in page, and a notice, which is still shown.
    const toolCall = {
      id: "host-old",
      method: "tool.call",
      params: { toolCallId: "call-1", toolName: "lookup", arguments: {} },
    } as const;
    const replayed = [
      dialogEvent({
        id: "ui-old",
        method: "ui.select",
        params: { title: "Which database?", options: [] },
      }),
      hostCallEvent(toolCall),
      hostCallEvent({ id: "uri-old", method: "uri.read", params: { url: "app://notes/1" } }),
      uiEvent({ type: "ui_open_url", url: "https://example.com/sign-in" }),
      uiEvent({ type: "ui_notify", message: "Startup notice" }),
    ];
    for (const [index, payload] of replayed.entries()) {
      ingest(store, payload, index + 1, true);
    }
    expect(store.getSnapshot().lastSeq).toBe(5);
    expect(store.getSnapshot().pending.dialogs).toEqual({});
    expect(store.getSnapshot().pending.hostTools).toEqual({});
    expect(store.getSnapshot().pending.hostUris).toEqual({});
    expect(notified).toEqual(["notice: Startup notice"]);
    // A dialog and a tool call asked now are live: they are kept and reach the listeners.
    ingest(
      store,
      dialogEvent({
        id: "ui-live",
        method: "ui.select",
        params: { title: "Which database?", options: [] },
      }),
      6,
    );
    ingest(store, hostCallEvent({ ...toolCall, id: "host-live" }), 7);
    expect(Object.keys(store.getSnapshot().pending.dialogs)).toEqual(["ui-live"]);
    expect(store.getSnapshot().pending.hostTools["host-live"]?.request).toEqual({
      ...toolCall,
      id: "host-live",
    });
    expect(notified).toEqual(["notice: Startup notice", "ui-live", "host_call"]);
  });

  test("omp's cancel of a tool call or a URI read drops it, and leaves the other calls waiting", () => {
    const store = new OmpRuntimeStore({ threadId });
    const call = (id: string, toolCallId: string) =>
      hostCallEvent({
        id,
        method: "tool.call",
        params: { toolCallId, toolName: "lookup", arguments: {} },
      });
    ingest(store, call("tool-1", "call-1"), 1);
    ingest(store, call("tool-2", "call-2"), 2);
    ingest(
      store,
      hostCallEvent({ id: "uri-1", method: "uri.read", params: { url: "app://a" } }),
      3,
    );
    ingest(store, hostCallCancelEvent("tool_cancel", "tool-1"), 4);
    ingest(store, hostCallCancelEvent("uri_cancel", "uri-1"), 5);
    expect(Object.keys(store.getSnapshot().pending.hostTools)).toEqual(["tool-2"]);
    expect(store.getSnapshot().pending.hostUris).toEqual({});
  });

  test("a dialog omp is still waiting on is recorded as pending without moving the sequence, once; a host call is not a dialog", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, { kind: "process", status: "ready" }, 1);
    const open = {
      id: "ask-open",
      method: "ui.confirm",
      params: { title: "Go on?", message: "" },
    } as const;
    store.recordOpenQuestion(open, 7);
    expect(store.getSnapshot()).toMatchObject({ lastSeq: 1 });
    expect(store.getSnapshot().pending.dialogs["ask-open"]).toMatchObject({
      receivedSeq: 7,
      request: { method: "ui.confirm" },
    });
    const revision = store.getSnapshot().revision;
    store.recordOpenQuestion(open, 7);
    store.recordOpenQuestion(
      {
        id: "call-open",
        method: "tool.call",
        params: { toolCallId: "call-1", toolName: "lookup", arguments: {} },
      },
      8,
    );
    expect(store.getSnapshot().revision).toBe(revision);
    expect(Object.keys(store.getSnapshot().pending.dialogs)).toEqual(["ask-open"]);
  });

  test("records a tool call's start, progress and end across a gap, since history never restores them", () => {
    const store = new OmpRuntimeStore({ threadId });
    // A fresh chat's first events predate the browser's subscription, so the first one it sees is a gap.
    ingest(store, { kind: "process", status: "ready" }, 6);
    expect(store.getSnapshot()).toMatchObject({ lastSeq: 0, needsRefetch: true });

    // A refetch restores messages and state, never a call omp is running: its start, progress and end are kept.
    omp(store, { type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash" }, 7);
    expect(store.getSnapshot().tools["bash-1" as ToolCallId]).toMatchObject({ status: "running" });
    omp(
      store,
      {
        type: "tool_execution_update",
        toolCallId: "bash-1",
        toolName: "bash",
        partialResult: "one",
      },
      8,
    );
    expect(store.getSnapshot().tools["bash-1" as ToolCallId]).toMatchObject({
      status: "partial",
      partialResult: "one",
    });
    omp(
      store,
      { type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", result: "done" },
      9,
    );
    expect(store.getSnapshot().tools["bash-1" as ToolCallId]).toMatchObject({
      status: "success",
      result: "done",
    });

    // Ordinary events in the gap are still dropped: the refetch covers them.
    omp(store, { type: "turn_start" }, 10);
    expect(store.getSnapshot()).toMatchObject({
      lastSeq: 0,
      needsRefetch: true,
      prompt: { streaming: false },
    });
    store.resetSequence();
    expect(store.getSnapshot()).toMatchObject({ lastSeq: 10, needsRefetch: false });
  });

  test("a get_state answer asked before a run started does not undo that run, but a later one is authoritative", () => {
    const store = new OmpRuntimeStore({ threadId });
    const askedAt = store.getSnapshot().lastSeq;
    omp(store, { type: "agent_start" }, 1);
    expect(store.getSnapshot().prompt.streaming).toBe(true);
    // omp answered before the run began, but the answer arrives after the run's first event.
    store.applySessionState({ isStreaming: false }, { asOfSeq: askedAt });
    expect(store.getSnapshot().prompt.streaming).toBe(true);
    // An answer asked once the run had started says what omp is doing now.
    store.applySessionState({ isStreaming: false }, { asOfSeq: 1 });
    expect(store.getSnapshot().prompt.streaming).toBe(false);
  });

  test("a turn that ends keeps the prompt streaming until the run ends, because omp is running until agent_end", () => {
    const store = new OmpRuntimeStore({ threadId });
    omp(store, { type: "agent_start" }, 1);
    omp(store, { type: "turn_start" }, 2);
    omp(store, { type: "turn_end" }, 3);
    // omp's own streaming flag stays true between two turns of one run, so the composer must still see a run.
    expect(store.getSnapshot().prompt.streaming).toBe(true);
    omp(store, { type: "turn_start" }, 4);
    omp(store, { type: "turn_end" }, 5);
    omp(store, { type: "agent_end" }, 6);
    expect(store.getSnapshot().prompt.streaming).toBe(false);
  });

  test("shows a reopened session's history on the active branch, oldest first", () => {
    const store = new OmpRuntimeStore({ threadId });
    const message = (id: string, parentId: string | null, role: string, text: string) => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-10-05T00:00:00.000Z",
      message: { role, content: text, timestamp: 1 },
    });
    store.pairEndedMessages(
      [
        message("u1", null, "user", "first question"),
        message("a1", "u1", "assistant", "first answer"),
        // An earlier edit left a second branch under the first question.
        message("a1-old", "u1", "assistant", "abandoned answer"),
        { type: "model_change", id: "m1", parentId: "a1", timestamp: "2026-10-05T00:00:01.000Z" },
        message("u2", "m1", "user", "second question"),
      ],
      "u2" as EntryId,
    );
    const snapshot = store.getSnapshot();
    expect(snapshot.messageOrder).toEqual([
      `entry:${threadId}:u1`,
      `entry:${threadId}:a1`,
      `entry:${threadId}:u2`,
    ]);
    expect(snapshot.messages[`entry:${threadId}:a1` as MessageKey]).toMatchObject({
      status: "persisted",
      entryId: "a1",
      parentId: "u1",
      message: { role: "assistant", content: "first answer" },
    });
  });
  test("a clear boundary hides the old branch and keeps only the latest segment", () => {
    const store = new OmpRuntimeStore({ threadId });
    const message = (id: string, parentId: string | null, text: string) => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-10-05T00:00:00.000Z",
      message: { role: "user", content: text, timestamp: 1 },
    });
    store.pairEndedMessages(
      [
        message("old", null, "before clear"),
        {
          type: "reset_boundary",
          id: "clear-1",
          parentId: "old",
          timestamp: "2026-10-05T00:00:01.000Z",
        },
        message("middle", "clear-1", "after first clear"),
        {
          type: "reset_boundary",
          id: "clear-2",
          parentId: "middle",
          timestamp: "2026-10-05T00:00:02.000Z",
        },
        message("new", "clear-2", "after second clear"),
      ],
      "new" as EntryId,
    );
    expect(store.getSnapshot().messageOrder).toEqual([`entry:${threadId}:new`]);
  });

  test("keeps the turn in progress after the history and shows each message once", () => {
    const store = new OmpRuntimeStore({ threadId });
    const entry = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-10-05T00:00:00.000Z",
      message: { role: "user", content: "question", timestamp: 1 },
    };
    store.pairEndedMessages([entry], "u1" as EntryId);
    // omp streams the same user message (it is also in get_entries), then starts the answer.
    omp(store, { type: "message_start", messageId: "m-user", message: entry.message }, 1);
    omp(store, { type: "message_end", messageId: "m-user", message: entry.message }, 2);
    omp(store, { type: "message_start", messageId: "m-answer", message: assistant("Hel") }, 3);
    // While the answer streams, the history (shown first) and the stream show each message once.
    expect(store.getSnapshot().messageOrder).toEqual([
      expect.stringMatching(/^stream:.*:m-user$/),
      expect.stringMatching(/^stream:.*:m-answer$/),
    ]);
    store.pairEndedMessages([entry], "u1" as EntryId);
    expect(store.getSnapshot().messageOrder).toEqual([
      `entry:${threadId}:u1`,
      expect.stringMatching(/^stream:.*:m-answer$/),
    ]);
  });

  test("shows a message once when the history returns it before its message_end arrives", () => {
    const store = new OmpRuntimeStore({ threadId });
    const user = { role: "user", content: "question", timestamp: 1 };
    const answer = { ...assistant("Hello there"), timestamp: 2 };
    omp(store, { type: "message_start", messageId: "m-user", message: user }, 1);
    omp(store, { type: "message_end", messageId: "m-user", message: user }, 2);
    omp(
      store,
      { type: "message_start", messageId: "m-answer", message: { ...answer, stopReason: "stop" } },
      3,
    );
    // omp persisted the answer, and the history load returns it while its stream is still open.
    store.pairEndedMessages(
      [
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-10-05T00:00:00.000Z",
          message: user,
        },
        {
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: "2026-10-05T00:00:01.000Z",
          message: { ...answer, stopReason: "toolUse" },
        },
      ],
      "a1" as EntryId,
    );
    expect(store.getSnapshot().messageOrder).toEqual([
      `entry:${threadId}:u1`,
      expect.stringMatching(/^stream:.*:m-answer$/),
    ]);
  });

  test("a history load that holds a message whose end was missed settles it: it is no longer streaming", () => {
    const store = new OmpRuntimeStore({ threadId });
    const user = { role: "user", content: "question", timestamp: 1 };
    const started = { ...assistant("Hel"), timestamp: 2 };
    const ended = { ...assistant("Hello there"), timestamp: 2 };
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-10-05T00:00:00.000Z",
        message: user,
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-10-05T00:00:01.000Z",
        message: ended,
      },
    ];
    omp(store, { type: "message_start", messageId: "m-user", message: user }, 1);
    omp(store, { type: "message_end", messageId: "m-user", message: user }, 2);
    omp(store, { type: "message_start", messageId: "m-answer", message: started }, 3);
    // omp's message_end for the answer never reaches the store: the answer stays a streaming copy.
    store.pairEndedMessages(entries, "a1" as EntryId);
    const shown = store.getSnapshot();
    expect(shown.messageOrder).toEqual([
      `entry:${threadId}:u1`,
      expect.stringMatching(/^stream:.*:m-answer$/),
    ]);
    const answer = shown.messageOrder[1] as MessageKey;
    expect(shown.messages[answer]).toMatchObject({
      status: "ended",
      message: { content: [{ type: "text", text: "Hello there" }] },
    });
    // The next history load pairs the answer with its entry, as it does after a message_end.
    store.pairEndedMessages(entries, "a1" as EntryId);
    expect(store.getSnapshot().messageOrder).toEqual([
      `entry:${threadId}:u1`,
      `entry:${threadId}:a1`,
    ]);
  });

  test("keeps what get_state says about the session, field by field", () => {
    const store = new OmpRuntimeStore({ threadId });
    const model = { provider: "anthropic", id: "claude-x", name: "Claude X", reasoning: true };
    store.applySessionState({
      model: model as never,
      thinkingLevel: "high",
      contextUsage: { tokens: 1200, contextWindow: 200_000, percent: 0.6 } as never,
      autoCompactionEnabled: true,
    });
    expect(store.getSnapshot().session).toMatchObject({
      model,
      thinkingLevel: "high",
      autoCompactionEnabled: true,
      isCompacting: false,
      revision: 1,
    });
    // A later answer without a field keeps the last value instead of clearing it.
    store.applySessionState({ isCompacting: true });
    expect(store.getSnapshot().session).toMatchObject({
      model,
      thinkingLevel: "high",
      isCompacting: true,
      revision: 2,
    });
  });

  test("shows a custom_message entry as a persisted custom message, with its text, flag, details and time", () => {
    const store = new OmpRuntimeStore({ threadId });
    const noticeAt = "2026-10-05T00:00:03.000Z";
    store.pairEndedMessages(
      [
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-10-05T00:00:00.000Z",
          message: { role: "user", content: "start two helpers", timestamp: 1 },
        },
        {
          type: "custom_message",
          id: "c1",
          parentId: "u1",
          timestamp: noticeAt,
          customType: "async-result",
          content: "<system-notice>\nBackground job Reviewer has completed.\n</system-notice>",
          display: true,
          details: { jobs: [{ jobId: "Reviewer", type: "task" }] },
        },
        { type: "model_change", id: "m1", parentId: "c1", timestamp: noticeAt },
      ],
      "m1" as EntryId,
    );
    const snapshot = store.getSnapshot();
    expect(snapshot.messageOrder).toEqual([`entry:${threadId}:u1`, `entry:${threadId}:c1`]);
    expect(snapshot.messages[`entry:${threadId}:c1` as MessageKey]).toMatchObject({
      status: "persisted",
      entryId: "c1",
      parentId: "u1",
      message: {
        role: "custom",
        customType: "async-result",
        content: "<system-notice>\nBackground job Reviewer has completed.\n</system-notice>",
        display: true,
        details: { jobs: [{ jobId: "Reviewer", type: "task" }] },
        timestamp: Date.parse(noticeAt),
      },
    });
  });

  test("a custom_message entry that lacks its kind or time is not a message", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.pairEndedMessages(
      [
        {
          type: "custom_message",
          id: "c1",
          parentId: null,
          timestamp: "not a time",
          customType: "x",
          content: "a",
          display: true,
        },
        {
          type: "custom_message",
          id: "c2",
          parentId: "c1",
          timestamp: "2026-10-05T00:00:00.000Z",
          content: "a",
          display: true,
        },
      ],
      "c2" as EntryId,
    );
    expect(store.getSnapshot().messageOrder).toEqual([]);
  });

  test("shows a branch_summary entry as a branch summary message, with its summary, source and time", () => {
    const store = new OmpRuntimeStore({ threadId });
    const summaryAt = "2026-10-05T00:00:02.000Z";
    store.pairEndedMessages(
      [
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-10-05T00:00:00.000Z",
          message: { role: "user", content: "start two helpers", timestamp: 1 },
        },
        {
          type: "branch_summary",
          id: "b1",
          parentId: "u1",
          timestamp: summaryAt,
          fromId: "u1-leaf",
          summary: "## Goal\n\nKeep the parser stable.",
        },
        { type: "model_change", id: "m1", parentId: "b1", timestamp: summaryAt },
      ],
      "m1" as EntryId,
    );
    const snapshot = store.getSnapshot();
    expect(snapshot.messageOrder).toEqual([`entry:${threadId}:u1`, `entry:${threadId}:b1`]);
    expect(snapshot.messages[`entry:${threadId}:b1` as MessageKey]).toMatchObject({
      status: "persisted",
      entryId: "b1",
      message: {
        role: "branchSummary",
        summary: "## Goal\n\nKeep the parser stable.",
        fromId: "u1-leaf",
        timestamp: Date.parse(summaryAt),
      },
    });
  });

  test("shows a compaction entry as a compaction summary message with its counts", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.pairEndedMessages(
      [
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-10-05T00:00:00.000Z",
          message: { role: "user", content: "start", timestamp: 1 },
        },
        {
          type: "compaction",
          id: "c1",
          parentId: "u1",
          timestamp: "2026-10-05T00:00:01.000Z",
          summary: "## Kept context\n\n- Keep the current goal",
          firstKeptEntryId: "u1",
          tokensBefore: 120_000,
          tokensAfter: 28_000,
          method: "remote",
          warning: "Compaction freed too little for maintenance.",
        },
        { type: "model_change", id: "m1", parentId: "c1", timestamp: "2026-10-05T00:00:01.000Z" },
      ],
      "m1" as EntryId,
    );
    const snapshot = store.getSnapshot();
    expect(snapshot.messageOrder).toEqual([`entry:${threadId}:u1`, `entry:${threadId}:c1`]);
    expect(snapshot.messages[`entry:${threadId}:c1` as MessageKey]).toMatchObject({
      status: "persisted",
      entryId: "c1",
      message: {
        role: "compactionSummary",
        summary: "## Kept context\n\n- Keep the current goal",
        tokensBefore: 120_000,
        tokensAfter: 28_000,
        method: "remote",
        timestamp: Date.parse("2026-10-05T00:00:01.000Z"),
        warning: "Compaction freed too little for maintenance.",
      },
    });
  });

  test("a branch_summary entry with an empty summary (omp's discard marker) is not a message", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.pairEndedMessages(
      [
        {
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-10-05T00:00:00.000Z",
          message: { role: "user", content: "start", timestamp: 1 },
        },
        {
          type: "branch_summary",
          id: "b1",
          parentId: "u1",
          timestamp: "2026-10-05T00:00:01.000Z",
          fromId: "u1",
          summary: "",
        },
        { type: "model_change", id: "m1", parentId: "b1", timestamp: "2026-10-05T00:00:01.000Z" },
      ],
      "m1" as EntryId,
    );
    expect(store.getSnapshot().messageOrder).toEqual([`entry:${threadId}:u1`]);
  });

  test("a live custom message pairs with its saved entry and shows once", () => {
    const store = new OmpRuntimeStore({ threadId });
    const noticeAt = Date.parse("2026-10-05T00:00:03.000Z");
    const live = {
      role: "custom",
      customType: "irc:incoming",
      content: "<irc>\nhello\n</irc>",
      display: true,
      details: { from: "Reviewer", message: "hello" },
      timestamp: noticeAt,
    };
    omp(store, { type: "message_start", messageId: "m-irc", message: live }, 1);
    omp(store, { type: "message_end", messageId: "m-irc", message: live }, 2);
    expect(store.getSnapshot().messageOrder).toEqual([expect.stringMatching(/^stream:.*:m-irc$/)]);

    store.pairEndedMessages(
      [
        {
          type: "custom_message",
          id: "c1",
          parentId: null,
          timestamp: new Date(noticeAt).toISOString(),
          customType: "irc:incoming",
          content: "<irc>\nhello\n</irc>",
          display: true,
          details: { from: "Reviewer", message: "hello" },
        },
      ],
      "c1" as EntryId,
    );
    // One row, now keyed by its saved entry: no second copy from the history.
    expect(store.getSnapshot().messageOrder).toEqual([`entry:${threadId}:c1`]);
  });

  test("a UI state event the server holds reaches the subscribers as replayed, and moves no sequence", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, { kind: "process", status: "ready" }, 1);
    const heard: Array<{ type: string; seq: number; replayed: boolean }> = [];
    store.subscribeNotifications(["ui_status"], (frame, seq, replayed) => {
      heard.push({ type: frame.type, seq, replayed });
    });
    store.recordState({ type: "ui_status", statusKey: "build", statusText: "Running" }, 2);
    expect(heard).toEqual([{ type: "ui_status", seq: 2, replayed: true }]);
    expect(store.getSnapshot().lastSeq).toBe(1);
  });

  test("an extension's error keeps the extension's name and omp's reason, under its own heading", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(
      store,
      notificationEvent({
        type: "extension_error",
        extensionPath: "/extensions/notes-ext/index.ts",
        event: "session_start",
        error: "index is locked",
      }),
      1,
    );
    ingest(store, { kind: "process", status: "ready" }, 2);
    expect(store.getSnapshot().error).toEqual({
      code: "omp_error",
      message: "index is locked",
      retryable: false,
      heading: "An extension reported an error",
      extension: "notes-ext",
    });
  });

  test("an error-level notice keeps the source omp gave it", () => {
    const store = new OmpRuntimeStore({ threadId });
    omp(store, { type: "notice", level: "error", message: "disk is full", source: "Context" }, 1);
    expect(store.getSnapshot().error).toMatchObject({
      message: "disk is full",
      heading: "omp reported a problem",
      source: "Context",
    });
  });

  test("a prompt marked sent stays sent through omp's events, until a refused send unmarks it", () => {
    const store = new OmpRuntimeStore({ threadId });
    expect(store.getSnapshot().prompt.sent).toBe(false);
    store.markPromptSent();
    omp(store, { type: "agent_start" }, 2);
    expect(store.getSnapshot().prompt.sent).toBe(true);
    store.unmarkPromptSent();
    expect(store.getSnapshot().prompt.sent).toBe(false);
  });
});

describe("a `!` command's row in the store", () => {
  const result = { output: "hi\n", exitCode: 0, cancelled: false, truncated: false };

  function bashEntry(id: string, command: string, output: string, timestamp: number) {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp: new Date(timestamp).toISOString(),
      message: {
        role: "bashExecution",
        command,
        output,
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp,
      },
    };
  }

  test("a command is one row from its running event to its ended event, which keeps omp's answer on it", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, bashEvent({ status: "running", command: "echo hi", startedAt: at }), 1);
    expect(store.getSnapshot().commands).toEqual([
      { seq: 1, startedAt: at, command: "echo hi", phase: "running" },
    ]);
    ingest(store, bashEvent({ status: "ended", command: "echo hi", startedAt: at, result }), 2);
    expect(store.getSnapshot().commands).toEqual([
      { seq: 1, startedAt: at, command: "echo hi", phase: "ended", result },
    ]);
  });

  test("the entry omp writes for the command takes the row's place, so the row goes and the message shows", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, bashEvent({ status: "running", command: "echo hi", startedAt: at }), 1);
    ingest(store, bashEvent({ status: "ended", command: "echo hi", startedAt: at, result }), 2);
    store.pairEndedMessages([bashEntry("e1", "echo hi", "hi\n", at + 5)], "e1" as EntryId);
    expect(store.getSnapshot().commands).toEqual([]);
    expect(Object.keys(store.getSnapshot().messages).some((key) => key.endsWith(":e1"))).toBe(true);
  });

  test("the entry takes the row's key too, so the row keeps its element when the entry replaces it", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, bashEvent({ status: "running", command: "echo hi", startedAt: at }), 1);
    ingest(store, bashEvent({ status: "ended", command: "echo hi", startedAt: at, result }), 2);
    store.pairEndedMessages([bashEntry("e1", "echo hi", "hi\n", at + 5)], "e1" as EntryId);
    const entry = Object.values(store.getSnapshot().messages).find(
      (message) => message.entryId === "e1",
    );
    if (entry === undefined) throw new Error("the entry's message is missing");
    expect(rowIdOf(entry)).toBe("stream:bash:1");
  });

  test("an ended event that a viewer replays from before it subscribed only drops its running row", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, bashEvent({ status: "running", command: "echo hi", startedAt: at }), 1, true);
    ingest(
      store,
      bashEvent({ status: "ended", command: "echo hi", startedAt: at, result }),
      2,
      true,
    );
    expect(store.getSnapshot().commands).toEqual([]);
  });

  test("an ended command whose entry the transcript already holds adds no row of its own", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.pairEndedMessages([bashEntry("e1", "echo hi", "hi\n", at + 5)], "e1" as EntryId);
    ingest(store, bashEvent({ status: "running", command: "echo hi", startedAt: at }), 1);
    ingest(store, bashEvent({ status: "ended", command: "echo hi", startedAt: at, result }), 2);
    expect(store.getSnapshot().commands).toEqual([]);
  });

  test("an older entry of an identical command does not take a new command's row; its own entry does", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.pairEndedMessages([bashEntry("e0", "echo hi", "hi\n", at - 1_000)], "e0" as EntryId);
    ingest(store, bashEvent({ status: "running", command: "echo hi", startedAt: at }), 1);
    ingest(store, bashEvent({ status: "ended", command: "echo hi", startedAt: at, result }), 2);
    expect(store.getSnapshot().commands).toHaveLength(1);
    store.pairEndedMessages([bashEntry("e1", "echo hi", "hi\n", at + 5)], "e1" as EntryId);
    expect(store.getSnapshot().commands).toEqual([]);
  });

  test("a command whose call failed ends as an ended row with no answer, which its entry replaces by its text", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, bashEvent({ status: "running", command: "sleep 1", startedAt: at }), 1);
    ingest(store, bashEvent({ status: "ended", command: "sleep 1", startedAt: at }), 2);
    expect(store.getSnapshot().commands).toEqual([
      { seq: 1, startedAt: at, command: "sleep 1", phase: "ended" },
    ]);
    store.pairEndedMessages([bashEntry("e1", "sleep 1", "", at + 5)], "e1" as EntryId);
    expect(store.getSnapshot().commands).toEqual([]);
  });

  test("an ended command whose running event this viewer never saw still shows its answer", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, bashEvent({ status: "ended", command: "echo hi", startedAt: at, result }), 5);
    expect(store.getSnapshot().commands).toEqual([
      { seq: 5, startedAt: at, command: "echo hi", phase: "ended", result },
    ]);
  });

  test("a bash event across a sequence gap is still recorded, so no running row is lost in the gap", () => {
    const store = new OmpRuntimeStore({ threadId });
    ingest(store, bashEvent({ status: "running", command: "sleep 1", startedAt: at }), 1);
    ingest(store, bashEvent({ status: "running", command: "echo hi", startedAt: at + 1 }), 3);
    expect(store.getSnapshot().commands.map((command) => command.command)).toEqual([
      "sleep 1",
      "echo hi",
    ]);
  });
});

describe("the row of a plain prompt, until omp's echo takes its place", () => {
  const image = { type: "image" as const, data: "aW1n", mimeType: "image/png" };
  const echo = (text: string, extra: Record<string, unknown> = {}) => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: at,
    ...extra,
  });

  /** The row a key holds in the store: the test fails when there is none. */
  function rowOf(store: OmpRuntimeStore, key: string): RuntimeMessage {
    const record = store.getSnapshot().messages[key as MessageKey];
    if (record === undefined) throw new Error(`no row for ${key}`);
    return record;
  }

  test("a plain new prompt adds its row in the same commit as markPromptSent, with its text and images", () => {
    const store = new OmpRuntimeStore({ threadId });
    let commits = 0;
    store.subscribe(() => {
      commits += 1;
    });
    const key = store.markPromptSent({ text: "hello", images: [image] }) as MessageKey;
    expect(commits).toBe(1);
    const snapshot = store.getSnapshot();
    expect(snapshot.prompt.sent).toBe(true);
    expect(snapshot.messageOrder).toEqual([]);
    expect(snapshot.pendingPrompts).toEqual([{ key, afterSeq: 0 }]);
    expect(snapshot.messages[key]).toMatchObject({
      key,
      status: "pending",
      message: { role: "user", content: [{ type: "text", text: "hello" }, image] },
    });
    expect(snapshot.streaming).toEqual({});
  });

  test("a send that is not a plain new prompt adds no row, only the sent mark", () => {
    const store = new OmpRuntimeStore({ threadId });
    expect(store.markPromptSent()).toBeUndefined();
    expect(store.getSnapshot()).toMatchObject({
      messageOrder: [],
      pendingPrompts: [],
      prompt: { sent: true },
    });
  });

  test("an empty prompt adds no row", () => {
    const store = new OmpRuntimeStore({ threadId });
    expect(store.markPromptSent({ text: "" })).toBeUndefined();
    expect(store.getSnapshot().messageOrder).toEqual([]);
  });

  test("omp's echo takes the row's place: the same index and row id, and no second row", () => {
    const store = new OmpRuntimeStore({ threadId });
    omp(store, { type: "message_start", messageId: "a1", message: assistant("earlier answer") }, 1);
    omp(store, { type: "message_end", messageId: "a1", message: assistant("earlier answer") }, 2);
    const pending = store.markPromptSent({ text: "next question" }) as MessageKey;
    omp(store, { type: "message_start", messageId: "u1", message: echo("next question") }, 3);
    const echoKey = "stream:thread-r0:0:u1" as MessageKey;
    expect(store.getSnapshot().messageOrder).toEqual(["stream:thread-r0:0:a1", echoKey]);
    expect(store.getSnapshot().messages[pending]).toBeUndefined();
    expect(store.getSnapshot().pendingPrompts).toEqual([]);
    expect(store.getSnapshot().messages[echoKey]).toMatchObject({
      key: echoKey,
      status: "streaming",
      rowKey: pending,
    });
    expect(rowIdOf(rowOf(store, echoKey))).toBe(pending);
    // The row keeps its id when the echo ends, so its element is not replaced at message_end.
    omp(store, { type: "message_end", messageId: "u1", message: echo("next question") }, 4);
    expect(store.getSnapshot().messageOrder).toEqual(["stream:thread-r0:0:a1", echoKey]);
    expect(rowIdOf(rowOf(store, echoKey))).toBe(pending);
  });

  test("an echo with a seq at or before the row's seq does not take the row", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.resetSequence(5);
    const pending = store.markPromptSent({ text: "waiting" }) as MessageKey;
    store.resetSequence(2);
    omp(store, { type: "message_start", messageId: "u-old", message: echo("waiting") }, 3);
    const snapshot = store.getSnapshot();
    expect(snapshot.pendingPrompts).toEqual([{ key: pending, afterSeq: 5 }]);
    expect(snapshot.messageOrder).toEqual(["stream:thread-r0:0:u-old"]);
    expect(rowIdOf(rowOf(store, "stream:thread-r0:0:u-old"))).toBe("stream:thread-r0:0:u-old");
  });

  test("two sends in a row, each replaced by its own echo, in order", () => {
    const store = new OmpRuntimeStore({ threadId });
    const first = store.markPromptSent({ text: "first" }) as MessageKey;
    const second = store.markPromptSent({ text: "second" }) as MessageKey;
    omp(store, { type: "message_start", messageId: "u1", message: echo("first") }, 1);
    omp(store, { type: "message_start", messageId: "u2", message: echo("second") }, 2);
    const snapshot = store.getSnapshot();
    expect(snapshot.messageOrder).toEqual(["stream:thread-r0:0:u1", "stream:thread-r0:0:u2"]);
    expect(rowIdOf(rowOf(store, "stream:thread-r0:0:u1"))).toBe(first);
    expect(rowIdOf(rowOf(store, "stream:thread-r0:0:u2"))).toBe(second);
    expect(snapshot.pendingPrompts).toEqual([]);
  });

  test("an echo that history already shows takes that row, and the pending row goes", () => {
    const store = new OmpRuntimeStore({ threadId });
    const pending = store.markPromptSent({ text: "saved" }) as MessageKey;
    store.pairEndedMessages(
      [
        {
          type: "message",
          id: "saved",
          parentId: null,
          timestamp: new Date(at).toISOString(),
          message: echo("saved"),
        },
      ],
      "saved" as EntryId,
    );
    omp(store, { type: "message_start", messageId: "u1", message: echo("saved") }, 1);
    const snapshot = store.getSnapshot();
    expect(snapshot.messageOrder).toEqual(["stream:thread-r0:0:u1"]);
    expect(snapshot.messages[pending]).toBeUndefined();
    expect(snapshot.pendingPrompts).toEqual([]);
    expect(rowIdOf(rowOf(store, "stream:thread-r0:0:u1"))).toBe("entry:thread-r0:saved");
  });

  test("a user message omp sends for an agent, or as synthetic, does not take the row", () => {
    const store = new OmpRuntimeStore({ threadId });
    const pending = store.markPromptSent({ text: "mine" }) as MessageKey;
    omp(
      store,
      {
        type: "message_start",
        messageId: "agent-note",
        message: echo("note", { attribution: "agent" }),
      },
      1,
    );
    omp(
      store,
      {
        type: "message_start",
        messageId: "synthetic-note",
        message: echo("continue", { synthetic: true }),
      },
      2,
    );
    expect(store.getSnapshot().pendingPrompts).toEqual([{ key: pending, afterSeq: 0 }]);
    expect(store.getSnapshot().messageOrder).toEqual([
      "stream:thread-r0:0:agent-note",
      "stream:thread-r0:0:synthetic-note",
    ]);
  });

  test("a refused send removes its row in the same commit as unmarkPromptSent", () => {
    const store = new OmpRuntimeStore({ threadId });
    const key = store.markPromptSent({ text: "refused" });
    let commits = 0;
    store.subscribe(() => {
      commits += 1;
    });
    store.unmarkPromptSent(key);
    expect(commits).toBe(1);
    expect(store.getSnapshot()).toMatchObject({
      messageOrder: [],
      pendingPrompts: [],
      prompt: { sent: false },
    });
    expect(Object.keys(store.getSnapshot().messages)).toEqual([]);
  });

  test("a refused send keeps the chat sent while another send's row is still in it", () => {
    const store = new OmpRuntimeStore({ threadId });
    const first = store.markPromptSent({ text: "first" });
    const second = store.markPromptSent({ text: "second" });
    store.unmarkPromptSent(second);
    expect(store.getSnapshot()).toMatchObject({ messageOrder: [], prompt: { sent: true } });
    expect(store.getSnapshot().pendingPrompts.map((pending) => pending.key)).toEqual([first]);
  });

  test("agent_end with no echo removes the row, since omp will not echo the prompt", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.markPromptSent({ text: "unanswered" });
    omp(store, { type: "agent_start" }, 1);
    omp(store, { type: "agent_end", messages: [] }, 2);
    expect(store.getSnapshot()).toMatchObject({ messageOrder: [], pendingPrompts: [] });
  });

  test("a prompt_result for a prompt omp never echoed removes the row, as for a prompt omp dropped", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.markPromptSent({ text: "dropped" });
    ingest(
      store,
      promptResultEvent({
        type: "prompt_result",
        agentInvoked: true,
        status: "aborted",
        sessionSettled: false,
      }),
      1,
    );
    expect(store.getSnapshot()).toMatchObject({ messageOrder: [], pendingPrompts: [] });
  });

  test.each(["exited", "stopped"])(
    "a process that %s removes the rows of prompts it never echoed",
    (status) => {
      const store = new OmpRuntimeStore({ threadId });
      store.markPromptSent({ text: "lost" });
      ingest(store, { kind: "process", status }, 1);
      expect(store.getSnapshot()).toMatchObject({ messageOrder: [], pendingPrompts: [] });
    },
  );

  test("a streamed copy keeps the row it took through its updates and its end", () => {
    const store = new OmpRuntimeStore({ threadId });
    store.pairEndedMessages(
      [
        {
          type: "message",
          id: "answer",
          parentId: null,
          timestamp: new Date(at).toISOString(),
          message: assistant("hello"),
        },
      ],
      "answer" as EntryId,
    );
    const streamed = "stream:thread-r0:0:m1" as MessageKey;
    omp(store, { type: "message_start", messageId: "m1", message: assistant("") }, 1);
    expect(rowIdOf(rowOf(store, streamed))).toBe("entry:thread-r0:answer");
    omp(
      store,
      {
        type: "message_update",
        messageId: "m1",
        message: assistant("hello"),
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "hello",
          partial: assistant("hello"),
        },
      },
      2,
    );
    expect(rowIdOf(rowOf(store, streamed))).toBe("entry:thread-r0:answer");
    omp(store, { type: "message_end", messageId: "m1", message: assistant("hello") }, 3);
    expect(rowIdOf(rowOf(store, streamed))).toBe("entry:thread-r0:answer");
  });
});
