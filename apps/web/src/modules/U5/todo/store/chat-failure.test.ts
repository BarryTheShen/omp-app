import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../../../R0/store";
import { TodoStoreAdapter } from "./store";

const threadId = ThreadId.parse("u5-todo-chat-failure");
const now = () => new Date("2026-10-05T00:00:00.000Z");

/** omp exits; the runtime records the process error that the chat's banner says. */
function processExit(): unknown {
  return {
    kind: "process",
    status: "exited",
    error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
  };
}

describe("the todo list and the chat's own failures", () => {
  test("omp exiting is the chat's failure: the chat says it, and the todo list is not in error", () => {
    const runtime = new OmpRuntimeStore({ threadId });
    const adapter = new TodoStoreAdapter({ store: runtime, now });
    runtime.ingest(processExit() as never, 1);
    expect(runtime.getSnapshot().error?.message).toBe("omp exited (signal SIGKILL)");
    expect(adapter.getSnapshot().error).toBeNull();
  });
});
