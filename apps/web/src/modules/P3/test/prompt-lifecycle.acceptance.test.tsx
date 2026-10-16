// The completed and aborted prompt_result frames and the session_settled frame are recorded (packages/omp-rpc/fixtures:
// prompt-stream:38, abort:23-24). The pending frame is the documented shape (rpc-types.ts:239-244 at omp v18.8.9). The provider error
// frame is a stand-in: no recording has one (fixtures/omp-branch.ts).
import type { RpcSessionEvent } from "@omp-app/contracts";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store";
import {
  promptAborted,
  promptCompleted,
  promptErrorStandIn,
  promptPending,
  SESSION_SETTLED,
  SOURCE_CHAT,
  USER_WITH_IMAGE,
} from "../fixtures/omp-branch";
import { editAppend, renderRun } from "./run-harness";

afterEach(cleanup);

/** One omp frame as the store receives it, numbered in arrival order. */
function receive(
  store: OmpRuntimeStore,
  kind: "prompt_result" | "session_settled",
  event: unknown,
  seq: number,
): void {
  store.ingest({ kind, event } as unknown as RpcSessionEvent, seq);
}

describe("acceptance: a prompt's result and the session's settling are separate facts", () => {
  test("a prompt_result that leaves background work open is not a settled session, and session_settled is", () => {
    const store = new OmpRuntimeStore({ threadId: SOURCE_CHAT });

    receive(store, "prompt_result", promptPending("req-1"), 1);
    expect(store.getSnapshot().prompt).toMatchObject({
      admitted: true,
      sessionSettled: false,
      promptResult: { status: "completed", sessionSettled: false },
    });

    receive(store, "session_settled", SESSION_SETTLED, 2);
    expect(store.getSnapshot().prompt).toMatchObject({ sessionSettled: true, streaming: false });
  });

  test("the recorded completed turn is admitted, and its result says the session is settled", () => {
    const store = new OmpRuntimeStore({ threadId: SOURCE_CHAT });

    receive(store, "prompt_result", promptCompleted(), 1);

    expect(store.getSnapshot().prompt).toMatchObject({
      admitted: true,
      streaming: false,
      promptResult: { status: "completed", sessionSettled: true },
    });
    expect(store.getSnapshot().error).toBeNull();
  });

  test("the recorded aborted turn is an aborted prompt, and it shows no error", () => {
    const store = new OmpRuntimeStore({ threadId: SOURCE_CHAT });

    receive(store, "prompt_result", promptAborted(), 1);

    expect(store.getSnapshot().prompt.promptResult).toMatchObject({ status: "aborted" });
    expect(store.getSnapshot().error).toBeNull();
  });

  test("a prompt_result error is an omp_error carrying the frame's message and retryable flag", () => {
    const store = new OmpRuntimeStore({ threadId: SOURCE_CHAT });

    receive(store, "prompt_result", promptErrorStandIn("req-2"), 1);

    expect(store.getSnapshot().error).toMatchObject({
      code: "omp_error",
      message: "stand-in provider message",
      retryable: true,
    });
  });

  test.skip("the run keeps an edit pending until session_settled, not prompt_result (spec §5.4 and §7.7; store.ts:1575 clears streaming at prompt_result; follow-up #1689)", async () => {
    const run = renderRun();

    await act(async () => {
      await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), "Explain again"));
    });
    receive(run.store, "prompt_result", promptPending("req-3"), 1);

    expect(run.store.getSnapshot().prompt).toMatchObject({ streaming: true });
  });
});
