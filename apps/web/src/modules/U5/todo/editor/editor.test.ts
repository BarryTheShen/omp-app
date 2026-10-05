import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { DialogHost } from "@/modules/U4/contract/dialog-host";
import type { TodoSnapshot, TodoStore } from "../contract";
import { TodoEditorController } from "./editor";

const initial: TodoSnapshot = {
  threadId: ThreadId.parse("u5-editor"),
  phases: [{ name: "Build", tasks: [{ content: "ship", status: "pending" }] }],
  source: "state",
  sequence: 1,
  updatedAt: "2026-10-05T00:00:00.000Z",
  reminder: null,
  error: null,
};

function store(setTodos: TodoStore["setTodos"] = async (phases) => phases): TodoStore {
  return {
    getSnapshot: () => initial,
    subscribe: () => () => undefined,
    setTodos,
  };
}

describe("TodoEditorController", () => {
  test("opens U4 editor, requires replacement confirmation, then calls setTodos", async () => {
    const calls: unknown[] = [];
    const dialogs: DialogHost = {
      open: async (request) => {
        calls.push(request);
        return {
          outcome: "answered",
          response: { kind: "editor", value: "## Build\n- [x] ship" },
        } as never;
      },
      confirm: async (request) => {
        calls.push(request);
        return true;
      },
    };
    const controller = new TodoEditorController({
      store: store(async (phases) => phases),
      dialogs,
      threadId: initial.threadId,
      now: () => 1,
    });

    await expect(controller.open()).resolves.toMatchObject({
      status: "saved",
      phases: [{ name: "Build", tasks: [{ status: "completed" }] }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ kind: "confirm" });
  });

  test("does not call setTodos when confirmation is denied", async () => {
    let writes = 0;
    const dialogs: DialogHost = {
      open: async () =>
        ({
          outcome: "answered",
          response: { kind: "editor", value: "## Build\n- [ ] ship" },
        }) as never,
      confirm: async () => false,
    };
    const controller = new TodoEditorController({
      store: store(async () => {
        writes += 1;
        return [];
      }),
      dialogs,
      threadId: initial.threadId,
      now: () => 2,
    });
    await expect(controller.open()).resolves.toEqual({ status: "rejected" });
    expect(writes).toBe(0);
  });

  test("cancellation from U4 leaves the canonical list untouched", async () => {
    const dialogs: DialogHost = {
      open: async () => ({ outcome: "cancelled", kind: "editor", timedOut: false }) as never,
      confirm: async () => true,
    };
    const controller = new TodoEditorController({
      store: store(),
      dialogs,
      threadId: initial.threadId,
      now: () => 3,
    });
    await expect(controller.open()).resolves.toEqual({ status: "cancelled" });
  });
});
