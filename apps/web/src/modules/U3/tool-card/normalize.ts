import type { AppError as AppErrorValue, ToolCallId } from "@omp-app/contracts";
import { AppError as AppErrorSchema, AppFailure } from "@omp-app/contracts";
import type { ToolCallState } from "@/modules/R0/store/store";
import type {
  NormalizeToolCallInput,
  OutputMeta,
  ToolCardError,
  ToolCardPhase,
  ToolCardState,
  ToolRendererProps,
} from "./contract";
import { splitToolResult } from "./result";

export interface ToolStateSource {
  readonly toolState?: ToolCallState;
  readonly outputMeta?: OutputMeta;
  readonly nested?: ToolRendererProps["nested"];
}

/** Normalize one assistant-ui part and its matching R0 state; no positional pairing is performed. */
export function normalizeToolRendererProps(
  props: ToolRendererProps,
  source: ToolStateSource = {},
): ToolCardState {
  return normalizeToolCall({
    toolCallId: props.toolCallId,
    toolName: props.toolName,
    args: props.args,
    argsText: props.argsText,
    result: props.result,
    isError: props.isError,
    status: props.status,
    toolState: source.toolState ?? props.toolState,
    outputMeta: source.outputMeta ?? props.outputMeta,
    nested: source.nested ?? props.nested,
    runActive: props.runActive,
  });
}

export function normalizeToolCall(input: NormalizeToolCallInput): ToolCardState {
  const rawToolCallId = typeof input.toolCallId === "string" ? input.toolCallId : "";
  const rawToolName = typeof input.toolName === "string" ? input.toolName : "";
  const toolCallId = asToolCallId(rawToolCallId) ?? INVALID_TOOL_CALL_ID;
  const toolName = nonEmpty(rawToolName) ?? "unknown";
  if (rawToolCallId.length === 0 || rawToolName.length === 0) {
    return malformedToolState(input, toolCallId, toolName);
  }

  const phase = resolvePhase(input);
  // A call its complete message holds, with no result and no state, while its run is active: omp has not started it.
  const queued =
    phase === "partial" &&
    input.status?.type === "complete" &&
    input.runActive === true &&
    input.toolState === undefined;
  const timedOut = isTimedOut(input.toolState?.result) || isTimedOut(input.result);
  const interruption =
    phase === "error" ? interruptionOf(input.toolState?.result ?? input.result) : undefined;
  const error = resolveError(input, phase, timedOut);
  const partialResult = resolvePartialResult(input, phase);
  const result = resolveFinalResult(input, phase);
  const isError = input.toolState?.isError === true || phase === "error";
  const argsComplete = resolveArgsComplete(input);
  const executionStarted = input.toolState !== undefined || (phase !== "running" && !queued);
  // omp's intent shows while the call is streaming or running, and not once it is queued or ended.
  const intent =
    (phase === "running" || phase === "partial") && !queued ? intentOf(input) : undefined;

  return {
    toolCallId,
    toolName,
    label: input.label ?? toolName,
    phase,
    args: input.args,
    argsText: input.argsText ?? serializeArgs(input.args),
    argsComplete,
    executionStarted,
    ...(queued ? { queued: true } : {}),
    ...(intent === undefined ? {} : { intent }),
    ...(partialResult === undefined ? {} : { partialResult }),
    ...(input.toolState?.streamProjection === undefined
      ? {}
      : { streamProjection: input.toolState.streamProjection }),
    ...(result === undefined ? {} : { result }),
    isError,
    ...(error === undefined ? {} : { error }),
    ...(interruption === undefined
      ? {}
      : { interruption: interruption.kind, interruptionText: interruption.text }),
    ...(phase === "cancelled" ? { cancelled: true } : {}),
    ...(timedOut ? { timedOut: true } : {}),
    ...(input.outputMeta === undefined ? {} : { outputMeta: input.outputMeta }),
    ...(input.nested === undefined
      ? {}
      : { nested: input.nested, messages: input.nested.messages }),
  };
}
const INVALID_TOOL_CALL_ID = "invalid-tool-call" as ToolCallId;

function malformedToolState(
  input: NormalizeToolCallInput,
  toolCallId: ToolCallId,
  toolName: string,
): ToolCardState {
  return {
    toolCallId,
    toolName,
    label: toolName === "unknown" ? "Unknown tool" : toolName,
    phase: "error",
    args: input.args,
    argsText: input.argsText ?? serializeArgs(input.args),
    argsComplete: false,
    executionStarted: false,
    isError: true,
    error: {
      code: "invalid_args",
      message: "Unable to render this tool call.",
      retryable: false,
    },
    ...(input.outputMeta === undefined ? {} : { outputMeta: input.outputMeta }),
    ...(input.nested === undefined
      ? {}
      : { nested: input.nested, messages: input.nested.messages }),
  };
}

function resolvePhase(input: NormalizeToolCallInput): ToolCardPhase {
  const sourceStatus = input.toolState?.status;
  const status = input.status;
  if (sourceStatus === "cancelled") return "cancelled";
  if (status?.type === "incomplete" && status.reason === "cancelled") return "cancelled";

  const settled =
    sourceStatus === "success" ||
    sourceStatus === "error" ||
    status?.type === "complete" ||
    status?.type === "incomplete";
  if (settled && interruptionOf(input.toolState?.result ?? input.result) !== undefined)
    return "error";
  if (input.toolState?.isError === true || input.isError === true) return "error";
  if (isTimedOut(input.toolState?.result) || isTimedOut(input.result)) return "error";
  if (sourceStatus !== undefined) {
    if (sourceStatus === "error") return "error";
    if (sourceStatus === "success") return "success";
    return sourceStatus;
  }
  if (status?.type === "running") return "running";
  if (status?.type === "requires-action") return "partial";
  if (status?.type === "incomplete") return "error";
  if (input.result !== undefined) return isTimedOut(input.result) ? "error" : "success";
  // The message is complete and holds no result for this call. While its run is active omp may simply not have
  // started it yet (an exclusive call waits for the calls before it), so it is queued. Once the run has ended no
  // result can arrive, so the call is unrecorded.
  if (status?.type === "complete") return input.runActive === true ? "partial" : "unrecorded";
  return "partial";
}

export interface ToolInterruption {
  readonly kind: "interrupted" | "skipped";
  readonly text: string;
}

export function interruptionOf(result: unknown): ToolInterruption | undefined {
  const split = splitToolResult(result);
  const details = split.isEnvelope ? split.details : result;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  const record = details as Record<string, unknown>;
  const nested = record.details;
  const metadata =
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : record;
  const source = metadata.source;
  const kind =
    metadata.__synthetic === true &&
    metadata.executed === false &&
    source === "assistant_stop_aborted"
      ? "interrupted"
      : metadata.__synthetic === true &&
          metadata.executed === false &&
          source === "interrupt_skipped"
        ? "skipped"
        : metadata.__interrupted === true &&
            source === "interrupt_skipped" &&
            metadata.execution === "started"
          ? "interrupted"
          : undefined;
  return kind === undefined ? undefined : { kind, text: split.text };
}

function resolveArgsComplete(input: NormalizeToolCallInput): boolean {
  if (input.status === undefined) return input.argsText !== undefined || input.args !== undefined;
  return input.status.type !== "running" && input.status.type !== "requires-action";
}

function resolvePartialResult(input: NormalizeToolCallInput, phase: ToolCardPhase): unknown {
  if (input.toolState?.partialResult !== undefined) return input.toolState.partialResult;
  return phase === "partial" || phase === "running" ? input.result : undefined;
}

function resolveFinalResult(input: NormalizeToolCallInput, phase: ToolCardPhase): unknown {
  if (input.toolState?.result !== undefined) return input.toolState.result;
  return phase === "success" || phase === "error" || phase === "cancelled"
    ? input.result
    : undefined;
}

function resolveError(
  input: NormalizeToolCallInput,
  phase: ToolCardPhase,
  timedOut: boolean,
): ToolCardError | undefined {
  const typed = appError(input.error);
  if (typed !== undefined) return typed;
  if (phase === "cancelled") {
    return { message: "Tool call cancelled.", retryable: false };
  }
  if (timedOut) {
    return { code: "timeout", message: "Tool call timed out.", retryable: false, timeout: true };
  }
  if (phase === "error") {
    // omp's own words for why a call failed are in the result's text ("Path 'x' not found").
    const reason = splitToolResult(input.toolState?.result ?? input.result).text.trim();
    return {
      message: reason === "" ? "The tool reported an error." : reason.slice(0, 600),
      retryable: false,
    };
  }
  return undefined;
}

function appError(value: unknown): ToolCardError | undefined {
  if (value instanceof AppFailure) return toolError(value.appError);
  const parsed = AppErrorSchema.safeParse(value);
  return parsed.success ? toolError(parsed.data) : undefined;
}

function toolError(error: AppErrorValue): ToolCardError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    timeout: error.code === "timeout",
  };
}

function isTimedOut(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if ("timedOut" in value && value.timedOut === true) return true;
  if (!("error" in value)) return false;
  const nested = value.error;
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return false;
  return "code" in nested && nested.code === "timeout";
}

function serializeArgs(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    const result = JSON.stringify(value);
    return result === undefined ? "" : result;
  } catch (error) {
    return error instanceof Error
      ? `[Unserializable arguments: ${error.message}]`
      : "[Unserializable arguments]";
  }
}

function asToolCallId(value: string): ToolCallId | undefined {
  return nonEmpty(value) as ToolCallId | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The intent omp's working line shows for a call (`packages/coding-agent/src/modes/controllers/event-controller.ts:167-173`):
 * the start event's intent, or before omp starts the call, the streamed `i` argument. Trimmed, without trailing periods.
 */
function intentOf(input: NormalizeToolCallInput): string | undefined {
  const streamed =
    typeof input.args === "object" && input.args !== null && "i" in input.args
      ? input.args.i
      : undefined;
  const raw = input.toolState?.intent ?? streamed;
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    .trim()
    .replace(/\s*\.+$/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}
