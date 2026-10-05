"use client";

import type { AddToolResultOptions, RespondToToolApprovalOptions } from "@assistant-ui/react";
import { AppFailure } from "@omp-app/contracts";
import {
  type ApprovalDecision,
  ApprovalDecisionSchema,
  type ApprovalPort,
  type ApprovalRequest,
  ApprovalRequestSchema,
  resolveApprovalDecision,
} from "../contract/approval";
import type { ConfirmDialogRequest, SelectDialogRequest } from "../contract/dialog";
import type { DialogHost, DialogHostOpenOptions } from "../contract/dialog-host";
import type { AnswerToolCall, ToolCallAnswer } from "../contract/tool-answer";

function failure(code: AppFailure["appError"]["code"], message: string): AppFailure {
  return new AppFailure({ code, message, retryable: code === "internal" });
}

function denied(reason: string): ApprovalDecision {
  return { outcome: "denied", reason };
}

function approvalDialogRequest(
  request: ApprovalRequest,
): ConfirmDialogRequest | SelectDialogRequest {
  if (request.kind === "confirm") {
    return {
      kind: "confirm",
      id: request.id,
      title: request.title,
      message: request.message,
      timeoutMs: request.timeoutMs,
    };
  }
  return {
    kind: "select",
    id: request.id,
    title: request.title,
    options: request.options,
    timeoutMs: request.timeoutMs,
  };
}

/** U4.4's R0.5-backed approval port. DialogHost remains the sole extension-UI answer path. */
export class ApprovalPortController implements ApprovalPort {
  private readonly dialogHost: DialogHost;
  private readonly inFlight = new Set<string>();

  public constructor(options: { readonly dialogHost: DialogHost }) {
    this.dialogHost = options.dialogHost;
  }

  public async resolve(
    request: ApprovalRequest,
    options: DialogHostOpenOptions,
  ): Promise<ApprovalDecision> {
    const parsed = ApprovalRequestSchema.safeParse(request);
    if (!parsed.success) throw failure("invalid_args", "The approval request failed validation.");
    const id = String(parsed.data.id);
    if (this.inFlight.has(id))
      throw failure("conflict", "This approval request is already being resolved.");
    this.inFlight.add(id);
    try {
      const result = await this.dialogHost.open(approvalDialogRequest(parsed.data), options);
      return resolveApprovalDecision(parsed.data, result);
    } catch (error) {
      if (error instanceof AppFailure) {
        if (error.appError.code === "unavailable") return denied("Approval UI is unavailable.");
        if (error.appError.code === "timeout") return denied("Approval timed out.");
        if (error.appError.code === "cancelled" || error.appError.code === "omp_exited") {
          return denied("Approval was cancelled.");
        }
      }
      throw error;
    } finally {
      this.inFlight.delete(id);
    }
  }
}

export interface AnswerToolCallActions {
  readonly onRespondToToolApproval: (options: RespondToToolApprovalOptions) => Promise<void>;
  readonly onResumeToolCall?: (options: {
    readonly toolCallId: string;
    readonly payload: unknown;
  }) => Promise<void>;
  readonly onAddToolResult?: (options: AddToolResultOptions) => Promise<void>;
  readonly humanResult?: (
    answer: Extract<ToolCallAnswer, { kind: "human-input" }>,
  ) => AddToolResultOptions;
}

/**
 * The only bridge from U4 approval/human-input controls into assistant-ui/R0 actions. One tool
 * call id is answered at most once; approval and human-input paths never invoke two callbacks.
 */
export function answerToolCall(actions: AnswerToolCallActions): AnswerToolCall {
  const inFlight = new Set<string>();
  const settled = new Set<string>();
  return async (answer, _options) => {
    const toolCallId = String(answer.toolCallId);
    if (settled.has(toolCallId) || inFlight.has(toolCallId)) {
      throw failure("conflict", "This tool call has already been answered.");
    }
    inFlight.add(toolCallId);
    try {
      if (answer.kind === "approval") {
        const decision = ApprovalDecisionSchema.safeParse(answer.decision);
        if (!decision.success)
          throw failure("invalid_args", "The approval decision failed validation.");
        const response: RespondToToolApprovalOptions = {
          approvalId: toolCallId,
          approved: decision.data.outcome === "approved",
          ...(decision.data.reason ? { reason: decision.data.reason } : {}),
        };
        await actions.onRespondToToolApproval(response);
      } else if (actions.onResumeToolCall) {
        await actions.onResumeToolCall({ toolCallId, payload: answer.payload });
      } else if (actions.onAddToolResult && actions.humanResult) {
        await actions.onAddToolResult(actions.humanResult(answer));
      } else {
        throw new AppFailure({
          code: "unavailable",
          message: "No human-input answer action is available.",
          retryable: false,
        });
      }
      settled.add(toolCallId);
    } catch (error) {
      throw error instanceof AppFailure
        ? error
        : new AppFailure(
            { code: "omp_error", message: "The tool answer failed.", retryable: true },
            { cause: error },
          );
    } finally {
      inFlight.delete(toolCallId);
    }
  };
}
