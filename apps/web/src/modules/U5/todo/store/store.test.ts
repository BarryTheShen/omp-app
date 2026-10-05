import { AppFailure, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { OmpRuntimeStore } from "../../../R0/store";
import type { TodoPhase } from "../contract";
import { type TodoRuntimeSource, TodoStoreAdapter } from "./store";

const threadId = ThreadId.parse("u5-todo-store");
const now = () => new Date("2026-10-05T00:00:00.000Z");

const phases: TodoPhase[] = [
  {
    name: "Build",
    tasks: [
      { content: "compile", status: "completed" },
      { content: "test", status: "in_progress", details: "run the suite" },
    ],
  },
];

function event(runtime: OmpRuntimeStore, value: unknown, sequence: number): void {
  runtime.ingest({ kind: "omp", event: value } as never, sequence);
}

describe("TodoStoreAdapter", () => {
  test("projects R0 state, preserves phase identity for unrelated updates, and notifies subscribers", () => {
    const runtime = new OmpRuntimeStore({ threadId });
    const adapter = new TodoStoreAdapter({ store: runtime, now });
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);

    expect(adapter.getSnapshot().phases).toEqual([]);
    runtime.applySessionState({ todoPhases: phases });
    const populated = adapter.getSnapshot();
    expect(populated.phases).toEqual(phases);
    const phaseReference = populated.phases;

    event(runtime, { type: "tool_execution_start", toolCallId: "read-1", toolName: "read" }, 1);
    expect(adapter.getSnapshot().phases).toBe(phaseReference);
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    const calls = listener.mock.calls.length;
    event(
      runtime,
      { type: "tool_execution_update", toolCallId: "read-1", toolName: "read", partialResult: "x" },
      2,
    );
    expect(listener).toHaveBeenCalledTimes(calls);
    adapter.dispose();
  });

  test("maps todo reminders without replacing canonical phases", () => {
    const runtime = new OmpRuntimeStore({ threadId });
    const adapter = new TodoStoreAdapter({ store: runtime, now });
    runtime.applySessionState({ todoPhases: phases });
    const phaseReference = adapter.getSnapshot().phases;

    event(
      runtime,
      {
        type: "todo_reminder",
        todos: [{ content: "test", status: "in_progress" }],
        attempt: 2,
        maxAttempts: 4,
      },
      1,
    );
    expect(adapter.getSnapshot()).toMatchObject({
      source: "reminder",
      phases: phaseReference,
      reminder: {
        attempt: 2,
        maxAttempts: 4,
        afterMessage: null,
        todos: [{ content: "test", status: "in_progress" }],
      },
    });
  });

  test("marks successful todo tool updates as tool-sourced", () => {
    const runtime = new OmpRuntimeStore({ threadId });
    const adapter = new TodoStoreAdapter({ store: runtime, now });
    event(
      runtime,
      {
        type: "tool_execution_end",
        toolCallId: "todo-1",
        toolName: "todo",
        result: { content: [], details: { op: "replace", phases } },
      },
      1,
    );
    expect(adapter.getSnapshot()).toMatchObject({ source: "tool", phases });
  });

  test("routes setTodos through R0 and accepts only the returned canonical phases", async () => {
    const calls: unknown[] = [];
    const canonical: TodoPhase[] = [
      { name: "Server", tasks: [{ content: "ship", status: "pending" }] },
    ];
    const runtime = new OmpRuntimeStore({
      threadId,
      transport: {
        send: async (request) => {
          calls.push(request);
          return { todoPhases: canonical };
        },
      },
    });
    const adapter = new TodoStoreAdapter({ store: runtime, now });
    const listener = vi.fn();
    adapter.subscribe(listener);

    await expect(adapter.setTodos(phases)).resolves.toEqual(canonical);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(calls).toMatchObject([{ threadId, command: { type: "set_todos", phases } }]);
    expect(adapter.getSnapshot()).toMatchObject({ source: "set_todos", phases: canonical });
  });

  test("keeps read-only data and surfaces an unavailable failure without a transport", async () => {
    const runtime = new OmpRuntimeStore({ threadId });
    const adapter = new TodoStoreAdapter({ store: runtime, now });
    runtime.applySessionState({ todoPhases: phases });
    const before = adapter.getSnapshot().phases;

    await expect(adapter.setTodos(phases)).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "omp.cmd.set_todos" },
    });
    expect(adapter.getSnapshot().phases).toBe(before);
  });

  test("turns malformed R0 state into an empty safe snapshot with an app error", () => {
    const runtime = new OmpRuntimeStore({ threadId });
    const malformed = {
      ...runtime.getSnapshot(),
      todoPhases: [{ name: "bad", tasks: [{ content: "x", status: "started" }] }],
    } as never;
    const source: TodoRuntimeSource = {
      getSnapshot: () => malformed,
      subscribe: () => () => undefined,
      setTodos: runtime.setTodos.bind(runtime),
    };
    const adapter = new TodoStoreAdapter({ store: source, now });

    expect(adapter.getSnapshot().phases).toEqual([]);
    expect(adapter.getSnapshot().error).toMatchObject({ code: "internal" });
  });

  test("rejects malformed input before touching R0", async () => {
    const runtime = new OmpRuntimeStore({ threadId });
    const adapter = new TodoStoreAdapter({ store: runtime, now });
    const invalid = [{ name: "bad", tasks: [{ content: "x", status: "started" }] }] as never;

    await expect(adapter.setTodos(invalid)).rejects.toBeInstanceOf(AppFailure);
    await expect(adapter.setTodos(invalid)).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(adapter.getSnapshot().phases).toEqual([]);
  });
});
