import type { ThreadMessageLike } from "@assistant-ui/react";
import { AppFailure, type ToolCallId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ToolCallState } from "@/modules/R0/store/store";
import type { ToolRendererProps } from "./contract";
import { normalizeToolCall, normalizeToolRendererProps } from "./normalize";

function toolState(
  toolCallId: string,
  status: ToolCallState["status"],
  extra: Partial<ToolCallState> = {},
): ToolCallState {
  return {
    toolCallId: toolCallId as ToolCallId,
    toolName: "bash",
    status,
    ...extra,
  };
}

describe("U3 tool-call normalizer", () => {
  test("keys out-of-order completion by toolCallId rather than index or arrival order", () => {
    const completed = [
      normalizeToolCall({
        toolCallId: "call-b",
        toolName: "read",
        toolState: toolState("call-b", "success", { result: "result-b" }),
      }),
      normalizeToolCall({
        toolCallId: "call-a",
        toolName: "read",
        toolState: toolState("call-a", "success", { result: "result-a" }),
      }),
    ];

    expect(completed.map((state) => [state.toolCallId, state.result])).toEqual([
      ["call-b", "result-b"],
      ["call-a", "result-a"],
    ]);
  });

  test("keeps partial result and stream projection through success and error", () => {
    const success = normalizeToolCall({
      toolCallId: "success",
      toolName: "bash",
      toolState: toolState("success", "success", {
        partialResult: "partial success",
        streamProjection: { tail: "live" },
        result: "final success",
      }),
    });
    const error = normalizeToolCall({
      toolCallId: "error",
      toolName: "bash",
      toolState: toolState("error", "error", {
        partialResult: "partial error",
        streamProjection: { tail: "before failure" },
        result: "failed result",
        isError: true,
      }),
    });

    expect(success).toMatchObject({
      phase: "success",
      partialResult: "partial success",
      streamProjection: { tail: "live" },
      result: "final success",
    });
    expect(error).toMatchObject({
      phase: "error",
      partialResult: "partial error",
      streamProjection: { tail: "before failure" },
      result: "failed result",
      isError: true,
    });
  });

  test("keeps args-complete separate from execution-started", () => {
    const pending = normalizeToolCall({
      toolCallId: "pending",
      toolName: "bash",
      args: { command: "echo hi" },
      argsText: '{"command":"echo',
      status: { type: "running" },
    });
    const started = normalizeToolCall({
      toolCallId: "started",
      toolName: "bash",
      args: { command: "echo hi" },
      argsText: '{"command":"echo hi"}',
      status: { type: "complete" },
      toolState: toolState("started", "running", { args: { command: "echo hi" } }),
    });

    expect(pending).toMatchObject({
      argsComplete: false,
      executionStarted: false,
      phase: "running",
    });
    expect(started).toMatchObject({ argsComplete: true, executionStarted: true, phase: "running" });
  });

  test("distinguishes timeout, cancellation and typed error", () => {
    const timeout = normalizeToolCall({
      toolCallId: "timeout",
      toolName: "bash",
      result: { timedOut: true },
      status: { type: "complete" },
    });
    const cancelled = normalizeToolCall({
      toolCallId: "cancelled",
      toolName: "bash",
      toolState: toolState("cancelled", "cancelled", { partialResult: "before abort" }),
    });
    const failure = normalizeToolCall({
      toolCallId: "failure",
      toolName: "bash",
      status: { type: "incomplete", reason: "error" },
      error: new AppFailure({ code: "internal", message: "tool failed", retryable: false }),
    });

    expect(timeout).toMatchObject({
      phase: "error",
      timedOut: true,
      error: { code: "timeout", timeout: true },
    });
    expect(timeout.cancelled).toBeUndefined();
    expect(cancelled).toMatchObject({
      phase: "cancelled",
      cancelled: true,
      partialResult: "before abort",
    });
    expect(cancelled.timedOut).toBeUndefined();
    expect(failure).toMatchObject({
      phase: "error",
      error: { code: "internal", retryable: false },
    });
  });

  test("turns a malformed assistant part into a visible fallback state", () => {
    const malformed = normalizeToolRendererProps({
      args: { malformed: true },
      argsText: "{malformed",
    } as unknown as ToolRendererProps);

    expect(malformed).toMatchObject({
      toolCallId: "invalid-tool-call",
      toolName: "unknown",
      phase: "error",
      isError: true,
      error: { code: "invalid_args" },
      defaultOpen: true,
    });
  });

  test("retains nested messages as a readonly source with lineage", () => {
    const messages = Object.freeze([
      { role: "assistant", content: [{ type: "text", text: "nested" }] },
    ]) as unknown as readonly ThreadMessageLike[];
    const nested = {
      parentTaskId: "parent" as ToolCallId,
      depth: 3,
      messages,
    };

    const state = normalizeToolCall({
      toolCallId: "parent",
      toolName: "task",
      result: "done",
      nested,
    });

    expect(state.messages).toBe(messages);
    expect(state.nested).toBe(nested);
    expect(state.nested?.depth).toBe(3);
  });
});

describe("U3 tool-call phase of a call with no result", () => {
  test("is unrecorded when its message is finished, running while it is still written, and in flight without a status", () => {
    const finished = normalizeToolCall({
      toolCallId: "yield-1",
      toolName: "yield",
      status: { type: "complete" },
    });
    expect(finished.phase).toBe("unrecorded");

    const live = normalizeToolCall({
      toolCallId: "bash-1",
      toolName: "bash",
      status: { type: "running" },
    });
    expect(live.phase).toBe("running");

    const unknown = normalizeToolCall({ toolCallId: "bash-2", toolName: "bash" });
    expect(unknown.phase).toBe("partial");
  });
});

describe("U3 tool-call queued state", () => {
  test("a call its complete message holds, with no result, is queued while its run is active and unrecorded once the run has ended", () => {
    const queued = normalizeToolCall({
      toolCallId: "queued-1",
      toolName: "bash",
      status: { type: "complete" },
      runActive: true,
    });
    expect(queued.phase).toBe("partial");
    expect(queued.queued).toBe(true);
    expect(queued.executionStarted).toBe(false);

    const ended = normalizeToolCall({
      toolCallId: "ended-1",
      toolName: "bash",
      status: { type: "complete" },
      runActive: false,
    });
    expect(ended.phase).toBe("unrecorded");
    expect(ended.queued).toBeUndefined();
  });

  test("a call that has started, or whose message is still being written, is never queued", () => {
    const started = normalizeToolCall({
      toolCallId: "started-1",
      toolName: "bash",
      status: { type: "complete" },
      runActive: true,
      toolState: toolState("started-1", "running"),
    });
    expect(started.phase).toBe("running");
    expect(started.queued).toBeUndefined();

    const writing = normalizeToolCall({
      toolCallId: "writing-1",
      toolName: "bash",
      status: { type: "running" },
      runActive: true,
    });
    expect(writing.phase).toBe("running");
    expect(writing.queued).toBeUndefined();
  });
});
