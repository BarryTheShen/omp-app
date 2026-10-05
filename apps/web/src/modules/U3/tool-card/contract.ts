import type {
  ThreadMessageLike,
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
  ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import type { AppError, ToolCallId, ToolDescriptor } from "@omp-app/contracts";
import type { ToolCallState } from "@/modules/R0/store/store";

export type ToolCardPhase = "running" | "partial" | "success" | "error" | "cancelled";

export interface ToolCardError {
  readonly code?: AppError["code"];
  readonly message: string;
  readonly retryable: boolean;
  readonly timeout?: boolean;
}

export type TruncationDirection = "head" | "tail" | "middle";
export type TruncationReason = "lines" | "bytes" | "middle";

export interface OutputRange {
  readonly start: number;
  readonly end: number;
}

/** Presentation metadata from a tool adapter; transport frame chunking is not truncation. */
export interface TruncationMeta {
  readonly direction: TruncationDirection;
  readonly reason: TruncationReason;
  readonly totalLines?: number;
  readonly shownLines?: number;
  readonly totalBytes?: number;
  readonly shownBytes?: number;
  readonly shownHead?: OutputRange;
  readonly shownTail?: OutputRange;
  readonly omittedLines?: number;
  readonly omittedBytes?: number;
  readonly artifactId?: string;
  readonly artifactElidedBytes?: number;
  readonly offset?: number;
  readonly partialLine?: boolean;
}

export interface OutputMeta {
  readonly truncation?: TruncationMeta;
  readonly source?: string;
  readonly artifactId?: string;
  readonly artifactElidedBytes?: number;
  readonly artifactError?: unknown;
  readonly diagnostics?: readonly unknown[];
  readonly limits?: readonly unknown[];
}

export interface NestedTranscriptSource {
  readonly parentTaskId?: ToolCallId;
  readonly depth: number;
  readonly messages: readonly ThreadMessageLike[];
}

/** One stable, render-only state for a single toolCallId. */
export interface ToolCardState {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly label: string;
  readonly phase: ToolCardPhase;
  readonly args?: unknown;
  /** Original assistant-ui args text, retained for lossless copy. */
  readonly argsText: string;
  readonly argsComplete: boolean;
  /** Distinct from argsComplete: exclusive tools may have final args before execution starts. */
  readonly executionStarted: boolean;
  readonly partialResult?: unknown;
  readonly streamProjection?: unknown;
  readonly result?: unknown;
  readonly isError: boolean;
  readonly error?: ToolCardError;
  readonly cancelled?: boolean;
  readonly timedOut?: boolean;
  readonly outputMeta?: OutputMeta;
  readonly messages?: readonly ThreadMessageLike[];
  readonly nested?: NestedTranscriptSource;
  /** A passive default; a later user override is kept separately by the card shell. */
  readonly defaultOpen: boolean;
  readonly userOpen?: boolean;
}

export type ToolRendererProps<TArgs = unknown, TResult = unknown> = ToolCallMessagePartProps<
  TArgs,
  TResult
> & {
  /** R0 detail may be injected by the runtime adapter; renderers never execute the tool. */
  readonly toolState?: ToolCallState;
  readonly outputMeta?: OutputMeta;
  readonly nested?: NestedTranscriptSource;
};

export type ToolRenderer<TArgs = unknown, TResult = unknown> = ToolCallMessagePartComponent<
  TArgs,
  TResult
>;

/** C0's data descriptor plus a local renderer; the renderer never enters the central registry. */
export type ToolRegistryDescriptor = ToolDescriptor & {
  readonly renderer: ToolRenderer;
};

export interface NormalizeToolCallInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly argsText?: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly status?: ToolCallMessagePartStatus;
  readonly toolState?: ToolCallState;
  readonly outputMeta?: OutputMeta;
  readonly nested?: NestedTranscriptSource;
  readonly label?: string;
}
