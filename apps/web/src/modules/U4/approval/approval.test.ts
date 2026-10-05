import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ApprovalRequest } from "../contract/approval";
import type { DialogRequest } from "../contract/dialog";
import type { DialogHost, DialogHostOpenOptions } from "../contract/dialog-host";
import type { DialogResult, DialogResultFor } from "../contract/responses";
import { type AnswerToolCallActions, ApprovalPortController, answerToolCall } from "./approval";

const requestId = "approval-1" as ApprovalRequest["id"];
const threadId = "approval-thread" as DialogHostOpenOptions["threadId"];

class FakeDialogHost implements DialogHost {
  readonly requests: DialogRequest[] = [];
  nextResult: DialogResult = {
    outcome: "answered",
    response: { kind: "select", value: "Approve" },
  };
  failure: AppFailure | undefined;

  open<R extends DialogRequest>(
    request: R,
    _options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>> {
    this.requests.push(request);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.nextResult as DialogResultFor<R>);
  }

  confirm(
    _request: Extract<DialogRequest, { kind: "confirm" }>,
    _options: DialogHostOpenOptions,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function selectRequest(): ApprovalRequest {
  return {
    kind: "select",
    id: requestId,
    title: "Allow tool?",
    options: ["Approve", "Deny"],
    approveOption: "Approve",
    toolCallId: "tool-call-1" as never,
    toolName: "bash",
  };
}

describe("ApprovalPortController", () => {
  test("presents exact approval options through DialogHost and returns approval", async () => {
    const dialogHost = new FakeDialogHost();
    const controller = new ApprovalPortController({ dialogHost });
    const decision = await controller.resolve(selectRequest(), { threadId });

    expect(dialogHost.requests).toEqual([
      {
        kind: "select",
        id: requestId,
        title: "Allow tool?",
        options: ["Approve", "Deny"],
        timeoutMs: undefined,
      },
    ]);
    expect(decision).toEqual({ outcome: "approved" });
  });

  test.each([
    [
      "cancel",
      { outcome: "cancelled", kind: "select", timedOut: false },
      "Cancelled before a decision was made.",
    ],
    [
      "timeout",
      { outcome: "cancelled", kind: "select", timedOut: true },
      "Timed out waiting for a decision.",
    ],
  ] as const)("fails closed on %s", async (_name, result, reason) => {
    const dialogHost = new FakeDialogHost();
    dialogHost.nextResult = result;
    const decision = await new ApprovalPortController({ dialogHost }).resolve(selectRequest(), {
      threadId,
    });
    expect(decision).toEqual({ outcome: "denied", reason });
  });

  test("returns a typed denial when UI is unavailable", async () => {
    const dialogHost = new FakeDialogHost();
    dialogHost.failure = new AppFailure({
      code: "unavailable",
      message: "UI unavailable",
      retryable: false,
      capability: "omp.ui",
    });
    const decision = await new ApprovalPortController({ dialogHost }).resolve(selectRequest(), {
      threadId,
    });
    expect(decision).toEqual({ outcome: "denied", reason: "Approval UI is unavailable." });
  });

  test("rejects duplicate approval resolutions while the first is pending", async () => {
    const gate = Promise.withResolvers<DialogResult>();
    const dialogHost = new FakeDialogHost();
    dialogHost.open = <R extends DialogRequest>() => gate.promise as Promise<DialogResultFor<R>>;
    const controller = new ApprovalPortController({ dialogHost });
    const first = controller.resolve(selectRequest(), { threadId });
    await expect(controller.resolve(selectRequest(), { threadId })).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
    gate.resolve({ outcome: "cancelled", kind: "select", timedOut: false });
    await expect(first).resolves.toEqual({
      outcome: "denied",
      reason: "Cancelled before a decision was made.",
    });
  });
});

describe("answerToolCall", () => {
  test("routes approval once through onRespondToToolApproval and rejects duplicates", async () => {
    const calls: unknown[] = [];
    const actions: AnswerToolCallActions = {
      onRespondToToolApproval: async (options) => {
        calls.push(options);
      },
    };
    const answer = answerToolCall(actions);
    await answer({
      kind: "approval",
      toolCallId: "tool-1" as never,
      decision: { outcome: "approved" },
    });
    expect(calls).toEqual([{ approvalId: "tool-1", approved: true }]);
    await expect(
      answer({ kind: "approval", toolCallId: "tool-1" as never, decision: { outcome: "denied" } }),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
  });

  test("routes human input to onResumeToolCall and never calls another seam", async () => {
    const resumed: unknown[] = [];
    const added: unknown[] = [];
    const actions: AnswerToolCallActions = {
      onRespondToToolApproval: async () => {
        throw new Error("approval seam must not run");
      },
      onResumeToolCall: async (options) => {
        resumed.push(options);
      },
      onAddToolResult: async (options) => {
        added.push(options);
      },
    };
    await answerToolCall(actions)({
      kind: "human-input",
      toolCallId: "tool-2" as never,
      payload: "text",
    });
    expect(resumed).toEqual([{ toolCallId: "tool-2", payload: "text" }]);
    expect(added).toEqual([]);
  });

  test("uses the typed add-tool-result fallback only when resume is absent", async () => {
    const added: unknown[] = [];
    const actions: AnswerToolCallActions = {
      onRespondToToolApproval: async () => {},
      onAddToolResult: async (options) => {
        added.push(options);
      },
      humanResult: (answer) => ({
        messageId: "message-1",
        toolName: "ask",
        toolCallId: String(answer.toolCallId),
        result: answer.payload as never,
        isError: false,
      }),
    };
    await answerToolCall(actions)({
      kind: "human-input",
      toolCallId: "tool-3" as never,
      payload: { answer: "yes" },
    });
    expect(added).toEqual([
      {
        messageId: "message-1",
        toolName: "ask",
        toolCallId: "tool-3",
        result: { answer: "yes" },
        isError: false,
      },
    ]);
  });

  test("wraps upstream failures and allows explicit retry after a failed action", async () => {
    let attempts = 0;
    const answer = answerToolCall({
      onRespondToToolApproval: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("upstream failed");
      },
    });
    await expect(
      answer({
        kind: "approval",
        toolCallId: "tool-4" as never,
        decision: { outcome: "approved" },
      }),
    ).rejects.toMatchObject({ appError: { code: "omp_error" } });
    await answer({
      kind: "approval",
      toolCallId: "tool-4" as never,
      decision: { outcome: "denied" },
    });
    expect(attempts).toBe(2);
  });
});
