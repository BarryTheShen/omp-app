import type {
  AttachmentAdapter as AssistantAttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";
import type {
  AttachmentRef,
  CapabilityKey,
  CapabilityMap,
  DraftScope,
  FailedSend,
  Revision,
} from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { ComponentType, ReactNode } from "react";
import type { PromptDelivery, PromptIntent, PromptMode } from "../../R0/runtime/runtime";

export type { PromptDelivery, PromptIntent, PromptMode } from "../../R0/runtime/runtime";

export type ComposerKeyChord =
  | "enter"
  | "shiftEnter"
  | "ctrlEnter"
  | "ctrlJ"
  | "escape"
  | "tab"
  | (string & {});

export type ComposerImeState = "idle" | "composing";
export function modeCapability(mode: PromptMode): CapabilityKey {
  switch (mode) {
    case "prompt":
      return "omp.cmd.prompt";
    case "bash":
      return "omp.cmd.bash";
    case "python":
      return "upstream.python-mode";
  }
}

export function isModeAvailable(mode: PromptMode, capabilities: CapabilityMap): boolean {
  return capabilities[modeCapability(mode)]?.state === "available";
}
export type ComposerSubmissionPhase = "idle" | "pending-admission" | "admitted" | "settled";

export interface ComposerDraft {
  readonly text: string;
  readonly images: readonly NonNullable<PromptIntent["images"]>[number][];
  readonly attachmentRefs: readonly AttachmentRef[];
}

export interface DraftRestoreRequest {
  readonly text: string;
  readonly attachmentRefs: readonly AttachmentRef[];
}
export type DraftPersistenceStatus = "idle" | "loading" | "ready" | "saving" | "conflict" | "error";

export interface ComposerDraftState {
  readonly scope: DraftScope;
  readonly text: string;
  readonly attachmentRefs: readonly AttachmentRef[];
  readonly failedSends: readonly FailedSend[];
  readonly revision: Revision | null;
  readonly dirty: boolean;
  readonly status: DraftPersistenceStatus;
  readonly error: AppFailure | null;
}

/** P6 uses this pure request to restore a queued message without submitting it. */
export function restoreDraft(
  text: string,
  attachmentRefs: readonly AttachmentRef[],
): DraftRestoreRequest {
  return {
    text,
    attachmentRefs: [...attachmentRefs],
  };
}

export interface SubmitPolicyInput {
  readonly isStreaming: boolean;
  readonly keyChord: ComposerKeyChord;
  readonly draft: ComposerDraft;
}

export interface SubmitDecision {
  readonly delivery: PromptDelivery;
}

export interface SplitSubmitDecision {
  readonly split: readonly PromptIntent[];
}

export type SubmitPolicyResult = SubmitDecision | SplitSubmitDecision;
export type SubmitPolicy = (input: SubmitPolicyInput) => SubmitPolicyResult;

/** U2's default is idle → new and streaming → steer; it never implicitly interrupts a run. */
export function defaultSubmitPolicy(input: SubmitPolicyInput): SubmitDecision {
  return { delivery: input.isStreaming ? "steer" : "new" };
}

export function resolveSubmitPolicy(
  policy: SubmitPolicy,
  input: SubmitPolicyInput,
): SubmitPolicyResult {
  const result = policy(input);
  if ("delivery" in result) {
    if (input.isStreaming && result.delivery === "new") {
      throw new AppFailure({
        code: "invalid_args",
        message: "A turn is running: choose steer or follow-up",
        retryable: false,
      });
    }
    return result;
  }
  if (result.split.length === 0) {
    throw new AppFailure({
      code: "invalid_args",
      message: "A split submission must contain at least one message",
      retryable: false,
    });
  }
  if (input.isStreaming && result.split.some((intent) => intent.delivery === "new")) {
    throw new AppFailure({
      code: "invalid_args",
      message: "A turn is running: split submissions must use steer or follow-up",
      retryable: false,
    });
  }
  return result;
}

export interface SubmissionState {
  readonly phase: ComposerSubmissionPhase;
  readonly intent: PromptIntent | null;
  readonly error: AppFailure | null;
  readonly restoredDraft: DraftRestoreRequest | null;
}

export interface ComposerFailureState {
  readonly phase: "pre-admission" | "post-admission";
  readonly error: AppFailure;
  readonly intent: PromptIntent;
}

export interface ComposerSurface {
  readonly draft: ComposerDraft;
  readonly draftState: ComposerDraftState;
  readonly mode: PromptMode;
  readonly ime: ComposerImeState;
  readonly submission: SubmissionState;
  readonly setDraft: (draft: ComposerDraft) => void;
  readonly submit: (policy?: SubmitPolicy) => Promise<void>;
  readonly cancel: () => void;
  readonly restoreDraft: (text: string, attachmentRefs: readonly AttachmentRef[]) => void;
}

export interface AttachmentState {
  readonly pending: readonly PendingAttachment[];
  readonly complete: readonly CompleteAttachment[];
  readonly error: AppFailure | null;
}

/** U2's stateful wrapper around assistant-ui's browser attachment adapter. */
export interface AttachmentAdapter extends AssistantAttachmentAdapter {
  readonly getState: () => AttachmentState;
  readonly subscribe: (listener: (state: AttachmentState) => void) => () => void;
  readonly toDraftRefs: () => readonly AttachmentRef[];
}

export interface ExternalEditorOpenOptions {
  readonly initialText: string;
  readonly signal?: AbortSignal;
}

export interface ExternalEditorAdapter {
  readonly open: (options: ExternalEditorOpenOptions) => Promise<string>;
}

export interface ComposerTriggerCandidate {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly insertText?: string;
}

export interface ComposerTriggerProvider {
  readonly trigger: "/" | "@" | "#" | ":" | `${string}://`;
  readonly search: (
    query: string,
  ) => readonly ComposerTriggerCandidate[] | Promise<readonly ComposerTriggerCandidate[]>;
}

export interface ComposerTriggerSlotProps {
  readonly providers: readonly ComposerTriggerProvider[];
  readonly onSelect: (candidate: ComposerTriggerCandidate) => void;
  readonly children?: ReactNode;
}

/** D2 supplies providers through the composition index; U2 owns the caret/IME-safe slot. */
export type ComposerTriggerSlot = ComponentType<ComposerTriggerSlotProps>;
