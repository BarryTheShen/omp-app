import type { ToolCallId, UiRequestId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { ApprovalRequest } from "./approval";
import { ApprovalDecisionSchema, ApprovalRequestSchema, resolveApprovalDecision } from "./approval";

const id = "req-1" as UiRequestId;
const toolCallId = "call-1" as ToolCallId;

describe("ApprovalRequestSchema", () => {
  test("accepts a representative select approval (the verified Approve/Deny wrapper shape)", () => {
    expect(
      ApprovalRequestSchema.safeParse({
        kind: "select",
        id,
        toolCallId,
        toolName: "bash",
        title: "Allow this tool?",
        options: ["Approve", "Deny"],
        approveOption: "Approve",
      }).success,
    ).toBe(true);
  });

  test("accepts a representative confirm approval (generic extension/consent confirmation)", () => {
    expect(
      ApprovalRequestSchema.safeParse({
        kind: "confirm",
        id,
        title: "Send this report?",
        message: "Share diagnostic details with the extension?",
      }).success,
    ).toBe(true);
  });

  test("rejects an approveOption not present in options, and an unknown extra field", () => {
    expect(
      ApprovalRequestSchema.safeParse({
        kind: "select",
        id,
        title: "Allow this tool?",
        options: ["Approve", "Deny"],
        approveOption: "Yes",
      }).success,
    ).toBe(false);
    expect(
      ApprovalRequestSchema.safeParse({
        kind: "confirm",
        id,
        title: "T",
        message: "M",
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});

describe("ApprovalDecisionSchema", () => {
  test("accepts approved and denied, with or without a reason", () => {
    expect(ApprovalDecisionSchema.safeParse({ outcome: "approved" }).success).toBe(true);
    expect(ApprovalDecisionSchema.safeParse({ outcome: "denied", reason: "no" }).success).toBe(
      true,
    );
  });

  test("rejects an unknown outcome", () => {
    expect(ApprovalDecisionSchema.safeParse({ outcome: "maybe" }).success).toBe(false);
  });
});

describe("resolveApprovalDecision", () => {
  const selectRequest: ApprovalRequest = {
    kind: "select",
    id,
    title: "Allow this tool?",
    options: ["Approve", "Deny"],
    approveOption: "Approve",
  };
  const confirmRequest: ApprovalRequest = {
    kind: "confirm",
    id,
    title: "Send this report?",
    message: "Share details?",
  };

  test("approves only on the exact matching select option or an explicit confirmed:true", () => {
    expect(
      resolveApprovalDecision(selectRequest, {
        outcome: "answered",
        response: { kind: "select", value: "Approve" },
      }),
    ).toEqual({ outcome: "approved" });
    expect(
      resolveApprovalDecision(confirmRequest, {
        outcome: "answered",
        response: { kind: "confirm", confirmed: true },
      }),
    ).toEqual({ outcome: "approved" });
  });

  test("denies on an explicit Deny option and an explicit confirmed:false", () => {
    expect(
      resolveApprovalDecision(selectRequest, {
        outcome: "answered",
        response: { kind: "select", value: "Deny" },
      }).outcome,
    ).toBe("denied");
    expect(
      resolveApprovalDecision(confirmRequest, {
        outcome: "answered",
        response: { kind: "confirm", confirmed: false },
      }),
    ).toEqual({ outcome: "denied" });
  });

  test("denies on cancellation and on timeout, never approves (fail-closed)", () => {
    expect(
      resolveApprovalDecision(selectRequest, {
        outcome: "cancelled",
        kind: "select",
        timedOut: false,
      }).outcome,
    ).toBe("denied");
    expect(
      resolveApprovalDecision(selectRequest, {
        outcome: "cancelled",
        kind: "select",
        timedOut: true,
      }).outcome,
    ).toBe("denied");
    expect(
      resolveApprovalDecision(confirmRequest, {
        outcome: "cancelled",
        kind: "confirm",
        timedOut: true,
      }).outcome,
    ).toBe("denied");
  });

  test("denies on an unexpected result shape rather than throwing", () => {
    expect(
      resolveApprovalDecision(selectRequest, {
        outcome: "answered",
        response: { kind: "input", value: "Approve" },
      }).outcome,
    ).toBe("denied");
  });
});
