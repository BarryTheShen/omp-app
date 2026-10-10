import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../../../R0/store";
import { TodoStoreAdapter } from "./store";

const threadId = ThreadId.parse("u5-todo-refused-key");
const now = () => new Date("2026-10-05T00:00:00.000Z");

/** omp's failed prompt, as the runtime receives it (a `prompt_result` with an error). */
function failedPrompt(httpStatus: number): unknown {
  return {
    kind: "prompt_result",
    event: {
      type: "prompt_result",
      agentInvoked: true,
      status: "error",
      sessionSettled: true,
      error: {
        message: "401 Invalid API key",
        retryable: false,
        provider: "openai",
        model: "gpt-6-luna",
        httpStatus,
      },
    },
  };
}

describe("the todo list and a failed prompt", () => {
  test("a refused key is the chat's failure, so the todo list is not in error", () => {
    const runtime = new OmpRuntimeStore({ threadId });
    const adapter = new TodoStoreAdapter({ store: runtime, now });
    runtime.ingest(failedPrompt(401) as never, 1);
    expect(runtime.getSnapshot().error?.omp?.httpStatus).toBe(401);
    expect(adapter.getSnapshot().error).toBeNull();
  });

  test("any other failed prompt still shows as the todo list's error", () => {
    const runtime = new OmpRuntimeStore({ threadId });
    const adapter = new TodoStoreAdapter({ store: runtime, now });
    runtime.ingest(failedPrompt(500) as never, 1);
    expect(adapter.getSnapshot().error?.message).toBe("401 Invalid API key");
  });
});
