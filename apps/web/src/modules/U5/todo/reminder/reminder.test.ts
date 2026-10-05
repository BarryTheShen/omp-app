import { ThreadId } from "@omp-app/contracts";
import { expect, test, vi } from "vitest";
import type { TodoSnapshot, TodoStore } from "../contract";
import { TodoReminderController, type TodoReminderTimer } from "./reminder";

function source(): { store: TodoStore; publish: (snapshot: TodoSnapshot) => void } {
  let current: TodoSnapshot = {
    threadId: ThreadId.parse("u5-reminder"),
    phases: [{ name: "Build", tasks: [{ content: "ship", status: "pending" }] }],
    source: "state",
    sequence: 1,
    updatedAt: "2026-10-05T00:00:00.000Z",
    reminder: null,
    error: null,
  };
  const listeners = new Set<(snapshot: TodoSnapshot) => void>();
  return {
    publish: (snapshot) => {
      current = snapshot;
      for (const listener of listeners) listener(current);
    },
    store: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setTodos: async (phases) => phases,
    },
  };
}

test("projects a passive reminder and badge count without stealing focus", () => {
  const fake = source();
  const controller = new TodoReminderController({ store: fake.store });
  fake.publish({
    ...fake.store.getSnapshot(),
    reminder: {
      todos: [{ content: "ship", status: "pending" }],
      attempt: 2,
      maxAttempts: 4,
      afterMessage: null,
    },
    sequence: 2,
  });
  expect(controller.getSnapshot()).toMatchObject({ badgeCount: 1, reminder: { attempt: 2 } });
  controller.dispose();
});

test("retains the previous list after R0 auto-clear and expires it", () => {
  const fake = source();
  let timeout: (() => void) | undefined;
  const timer: TodoReminderTimer = {
    setTimeout: (callback) => {
      timeout = callback;
      return 1;
    },
    clearTimeout: vi.fn(),
  };
  const controller = new TodoReminderController({ store: fake.store, timer, retentionMs: 10 });
  fake.publish({ ...fake.store.getSnapshot(), phases: [], sequence: 2 });
  expect(controller.getSnapshot()).toMatchObject({
    cleared: true,
    previousPhases: [{ name: "Build" }],
  });
  timeout?.();
  expect(controller.getSnapshot()).toMatchObject({ cleared: false, previousPhases: null });
  controller.dispose();
});
