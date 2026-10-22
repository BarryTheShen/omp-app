import type {
  ThreadMessageLike,
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
  ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import type { AppError, ToolCallId, ToolDescriptor } from "@omp-app/contracts";
import type { ToolCallState } from "@/modules/R0/store/store";

/**
 * `unrecorded`: the call's message is finished and no result was recorded. It is settled, not in flight. A call whose
 * message is still being written is `running`.
 */
export type ToolCardPhase =
  | "running"
  | "partial"
  | "success"
  | "error"
  | "cancelled"
  | "unrecorded";

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
  /**
   * omp's intent for the call (the model's `i` argument): trimmed and without trailing periods, as omp's working line
   * shows it. Set only while the call is in flight (streaming or running); a finished call has none.
   */
  readonly intent?: string;
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
  /** omp's exact result text for an interrupted or skipped call, retained when a renderer hides raw result data. */
  readonly interruptionText?: string;
  /** omp marked a synthetic call that did not run; this label leaves the underlying error phase unchanged. */
  readonly interruption?: "interrupted" | "skipped";
  readonly messages?: readonly ThreadMessageLike[];
  readonly nested?: NestedTranscriptSource;
  /**
   * omp has not started this call yet: its run is still active and it has no result or state. The phase
   * stays in flight, so each card keeps its in-flight look; the generic card says Waiting.
   */
  readonly queued?: boolean;
}

export type ToolRendererProps<TArgs = unknown, TResult = unknown> = ToolCallMessagePartProps<
  TArgs,
  TResult
> & {
  /** R0 detail may be injected by the runtime adapter; renderers never execute the tool. */
  readonly toolState?: ToolCallState;
  readonly outputMeta?: OutputMeta;
  readonly nested?: NestedTranscriptSource;
  /** Whether the run that owns this call is still active: the chat's run, or a worker that is live. */
  readonly runActive?: boolean;
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
  /** The part's own flag: omp marked this tool result as a failure (set on parts loaded from history too). */
  readonly isError?: boolean;
  readonly error?: unknown;
  readonly status?: ToolCallMessagePartStatus;
  readonly toolState?: ToolCallState;
  readonly outputMeta?: OutputMeta;
  readonly nested?: NestedTranscriptSource;
  readonly label?: string;
  /** Whether the run that owns this call is still active (see ToolRendererProps.runActive). */
  readonly runActive?: boolean;
}
