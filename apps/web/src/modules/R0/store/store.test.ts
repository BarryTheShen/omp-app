import type {
  EntryId,
  MessageKey,
  ProvisionalMessageKey,
  RpcSessionEvent,
  ThreadId,
  ToolCallId,
  UiRequestId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "./store";

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

function ingest(store: OmpRuntimeStore, event: unknown, seq: number): void {
  store.ingest(event as RpcSessionEvent, seq);
}

function omp(store: OmpRuntimeStore, event: unknown, seq: number): void {
  ingest(store, { kind: "omp", event }, seq);
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
    expect(Object.isFrozen(before.messages)).toBe(true);
    expect(() => {
      (before.messages as Record<string, unknown>).new = {};
    }).toThrow();
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

  test("cancels active tools on abort, settlement, and process exit", () => {
    const aborted = new OmpRuntimeStore({ threadId });
    omp(aborted, { type: "tool_execution_start", toolCallId: "abort-tool", toolName: "bash" }, 1);
    ingest(
      aborted,
      {
        kind: "prompt_result",
        event: {
          type: "prompt_result",
          agentInvoked: true,
          status: "aborted",
          sessionSettled: false,
        },
      },
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
    ingest(settled, { kind: "session_settled", event: { type: "session_settled" } }, 3);
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
        {
          kind: "prompt_result",
          event: {
            type: "prompt_result",
            agentInvoked: true,
            status: "completed",
            sessionSettled: false,
            id: `prompt-${index}`,
          },
        },
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
    expect(Object.isFrozen(after.tools)).toBe(true);
    expect(Object.isFrozen(after.tools["b" as ToolCallId])).toBe(true);
  });

  test("keeps prompt_result and session_settled distinct, including abort", () => {
    const store = new OmpRuntimeStore({ threadId });
    omp(store, { type: "agent_start" }, 1);
    ingest(
      store,
      {
        kind: "prompt_result",
        event: {
          type: "prompt_result",
          agentInvoked: true,
          status: "aborted",
          sessionSettled: false,
          id: "p1",
        },
      },
      2,
    );
    expect(store.getSnapshot().prompt).toMatchObject({
      admitted: true,
      streaming: false,
      promptResult: { status: "aborted", sessionSettled: false, id: "p1" },
      sessionSettled: false,
    });

    ingest(store, { kind: "session_settled", event: { type: "session_settled" } }, 3);
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

    ingest(store, { kind: "notification", frame: lifecycle }, 1);
    ingest(store, { kind: "notification", frame: progress }, 2);
    ingest(store, { kind: "notification", frame: command }, 3);
    ingest(store, { kind: "notification", frame: progress }, 2);

    expect(received).toEqual([
      { type: "subagent_lifecycle", seq: 1, frame: lifecycle },
      { type: "subagent_progress", seq: 2, frame: progress },
    ]);
    expect(other).toEqual(["command_output"]);
    unsubscribe();
    unsubscribeOther();
    ingest(store, { kind: "notification", frame: lifecycle }, 4);
    expect(received).toHaveLength(2);
    expect(other).toEqual(["command_output"]);
  });

  test("tracks queues, modes, todos, pending UI requests, and answers", async () => {
    const calls: unknown[] = [];
    const setTodoCalls: unknown[] = [];
    const store = new OmpRuntimeStore({
      threadId,
      transport: {
        answerExtensionUi: async (args) => {
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
      {
        kind: "notification",
        frame: {
          type: "extension_ui_request",
          id: "ui-1",
          method: "confirm",
          title: "Continue?",
          message: "yes",
        },
      },
      4,
    );
    expect(store.getSnapshot().pending.extensionUi["ui-1"]?.request).toMatchObject({
      method: "confirm",
    });
    await store.answerExtensionUi({
      type: "extension_ui_response",
      id: "ui-1" as UiRequestId,
      confirmed: true,
    });
    expect(store.getSnapshot().pending.extensionUi).toEqual({});
    expect(calls).toHaveLength(1);
  });

  test("ignores unknown notifications, replays, and events after a sequence gap", () => {
    const store = new OmpRuntimeStore({ threadId });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    ingest(
      store,
      { kind: "notification", frame: { type: "future_notification", payload: { x: 1 } } },
      1,
    );
    expect(store.getSnapshot().lastSeq).toBe(1);
    const revision = store.getSnapshot().revision;
    ingest(
      store,
      { kind: "notification", frame: { type: "future_notification", payload: { x: 2 } } },
      1,
    );
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

  test("shows a reopened session's history on the active branch, oldest first", () => {
    const store = new OmpRuntimeStore({ threadId });
    const message = (id: string, parentId: string | null, role: string, text: string) => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-10-05T00:00:00.000Z",
      message: { role, content: text, timestamp: 1 },
    });
    store.setTree(
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

  test("keeps the turn in progress after the history and shows each message once", () => {
    const store = new OmpRuntimeStore({ threadId });
    const entry = {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-10-05T00:00:00.000Z",
      message: { role: "user", content: "question", timestamp: 1 },
    };
    store.setTree([entry], "u1" as EntryId);
    // omp streams the same user message (it is also in get_entries), then starts the answer.
    omp(store, { type: "message_start", messageId: "m-user", message: entry.message }, 1);
    omp(store, { type: "message_end", messageId: "m-user", message: entry.message }, 2);
    omp(store, { type: "message_start", messageId: "m-answer", message: assistant("Hel") }, 3);
    store.pairEndedMessages([entry], "u1" as EntryId);
    expect(store.getSnapshot().messageOrder).toEqual([
      `entry:${threadId}:u1`,
      expect.stringMatching(/^stream:.*:m-answer$/),
    ]);
  });
});
