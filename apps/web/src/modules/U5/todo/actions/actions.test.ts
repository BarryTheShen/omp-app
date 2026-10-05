import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { TodoSnapshot, TodoStore } from "../contract";
import { TodoActions } from "./actions";
import { runTodoCommand, type TodoCommandGateway } from "./commands";

const phases = [
  {
    name: "Build",
    tasks: [
      { content: "write tests", status: "pending" as const },
      { content: "ship", status: "completed" as const },
    ],
  },
  { name: "Review", tasks: [{ content: "approve", status: "pending" as const }] },
];

function fakeStore(initial: TodoSnapshot["phases"] = phases): {
  store: TodoStore;
  calls: TodoSnapshot["phases"][];
} {
  let current: TodoSnapshot = {
    threadId: ThreadId.parse("u5-actions"),
    phases: [...initial],
    source: "state",
    sequence: 1,
    updatedAt: "2026-10-05T00:00:00.000Z",
    reminder: null,
    error: null,
  };
  const calls: TodoSnapshot["phases"][] = [];
  return {
    calls,
    store: {
      getSnapshot: () => current,
      subscribe: () => () => undefined,
      setTodos: async (next) => {
        calls.push([...next]);
        current = {
          ...current,
          phases: [...next],
          source: "set_todos",
          sequence: current.sequence + 1,
        };
        return next;
      },
    },
  };
}

describe("TodoActions", () => {
  test("routes done/reopen/add/remove/reorder payloads through setTodos", async () => {
    const fake = fakeStore();
    const actions = new TodoActions({ store: fake.store });

    await actions.done({ kind: "task", query: "write" });
    expect(fake.calls.at(-1)?.[0]?.tasks[0]?.status).toBe("completed");
    await actions.reopen({ kind: "phase", query: "review" });
    expect(fake.calls.at(-1)?.[1]?.tasks[0]?.status).toBe("pending");
    await actions.add({ phase: "Build", content: "publish", index: 1 });
    expect(fake.calls.at(-1)?.[0]?.tasks[1]).toMatchObject({
      content: "publish",
      status: "pending",
    });
    await actions.reorder({ phase: "Build", from: 1, to: 0 });
    expect(fake.calls.at(-1)?.[0]?.tasks[0]?.content).toBe("publish");
    await actions.remove({ kind: "task", query: "publish" });
    expect(fake.calls.at(-1)?.[0]?.tasks).toHaveLength(2);
  });

  test("rejects ambiguous fuzzy matches and does not call setTodos", async () => {
    const fake = fakeStore([
      { name: "Build", tasks: [{ content: "test one", status: "pending" }] },
      { name: "Review", tasks: [{ content: "test two", status: "pending" }] },
    ]);
    const actions = new TodoActions({ store: fake.store });
    await expect(actions.done({ kind: "task", query: "test" })).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("gates mutations with a visible capability reason", async () => {
    const fake = fakeStore();
    const actions = new TodoActions({
      store: fake.store,
      canMutate: () => ({ available: false, reason: "omp.cmd.set_todos is unavailable" }),
    });
    await expect(actions.done({ kind: "task", query: "ship" })).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "omp.cmd.set_todos" },
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("keeps slash commands in the A1 gateway and never parses command output", async () => {
    const calls: unknown[] = [];
    const gateway: TodoCommandGateway = {
      run: async (args) => {
        calls.push(args);
        return {
          command: args.command,
          status: "completed",
          agentInvoked: false,
          promptSettled: true,
          sessionSettled: true,
          outputs: [{ text: "done" }],
          sessionUpdates: [],
          configUpdates: [],
        };
      },
    };
    await runTodoCommand(gateway, ThreadId.parse("u5-actions"), "/todo done write tests");
    expect(calls).toMatchObject([{ command: "/todo done write tests" }]);
  });
});
