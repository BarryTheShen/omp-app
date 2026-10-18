import { z } from "zod";
import { MarkdownContent } from "../U1/markdown";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolCardState, ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { decodeCheckpoint, decodeCheckpointArgs, decodeRewind, decodeRewindArgs } from "./models";

const MAX_SUMMARY = 96;
const HIDE_RESULT = "[&_[data-slot='u3-tool-card-result']]:hidden";

/** omp's tool result text (`{ content: [{ type: "text", text }] }`). */
const ResultTextSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});

export function CheckpointCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const output = normalized.result ?? normalized.partialResult;
  const { state, resultRepeatsBanner } = withFailureReason(normalized, output);
  // omp results carry structured data under `details`; bare detail objects pass through.
  const decoded = decodeCheckpoint(
    output !== null && typeof output === "object" && "details" in output ? output.details : output,
  );
  const requested = decodeCheckpointArgs(state.args);
  const goal =
    (requested.ok ? requested.value.goal : undefined) ??
    (decoded.ok ? decoded.value.goal : undefined);
  // The card's label already says "checkpoint"; the summary carries only the goal.
  const summary = goal === undefined ? undefined : oneLine(goal, MAX_SUMMARY);

  return (
    <div data-testid={`t7-checkpoint-card-${state.toolCallId}`}>
      <ToolCard
        className={resultRepeatsBanner ? HIDE_RESULT : undefined}
        rawResult={rawText(output)}
        state={state}
        summary={summary}
      >
        {!decoded.ok && state.phase === "success" && (
          <p className="text-muted-foreground py-1 text-xs">Checkpoint details unavailable.</p>
        )}
      </ToolCard>
    </div>
  );
}

export function RewindCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const output = normalized.result ?? normalized.partialResult;
  const { state, resultRepeatsBanner } = withFailureReason(normalized, output);
  const decoded = decodeRewind(
    output !== null && typeof output === "object" && "details" in output ? output.details : output,
  );
  const requested = decodeRewindArgs(state.args);
  const report = (
    (decoded.ok ? decoded.value.report : undefined) ??
    (requested.ok ? requested.value.report : undefined) ??
    ""
  ).trim();
  const [head = "", ...rest] = report.split("\n");
  const firstLine = oneLine(head, MAX_SUMMARY);
  const summary = firstLine.length === 0 ? undefined : firstLine;
  // The header carries the report's first line (cut to fit only when it is long); the body shows
  // what follows, so no line appears twice.
  const body = (firstLine === head.trim() ? rest.join("\n") : report).trim();
  const showReport = state.phase !== "error" && body.length > 0;

  return (
    <div data-testid={`t7-rewind-card-${state.toolCallId}`}>
      <ToolCard
        className={resultRepeatsBanner ? HIDE_RESULT : undefined}
        rawResult={rawText(output)}
        state={state}
        summary={summary}
      >
        {!decoded.ok && state.phase === "success" && (
          <p className="text-muted-foreground py-1 text-xs">Rewind details unavailable.</p>
        )}
        {showReport && (
          <div className="min-w-0 py-1 text-sm" data-testid="t7-rewind-report">
            <MarkdownContent text={body} variant="compact" />
          </div>
        )}
      </ToolCard>
    </div>
  );
}

export const CheckpointToolRenderer: ToolRenderer = (props) => (
  <CheckpointCard rendererProps={props} />
);
export const RewindToolRenderer: ToolRenderer = (props) => <RewindCard rendererProps={props} />;

/**
 * omp reports checkpoint/rewind failures as the result text
 * (packages/coding-agent/src/tools/checkpoint.ts:79-81,115-126). Without a typed error, that text is
 * the banner's reason, and a raw result holding only that text would repeat it.
 */
function withFailureReason(
  normalized: ToolCardState,
  output: unknown,
): { readonly state: ToolCardState; readonly resultRepeatsBanner: boolean } {
  const parsed = ResultTextSchema.safeParse(output);
  const text = parsed.success
    ? parsed.data.content
        .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
        .join("\n")
        .trim()
    : "";
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (
    normalized.phase !== "error" ||
    normalized.error?.code !== undefined ||
    firstLine.length === 0
  ) {
    return { state: normalized, resultRepeatsBanner: false };
  }
  return {
    state: { ...normalized, error: { message: firstLine, retryable: false } },
    resultRepeatsBanner: parsed.success && text === firstLine && parsed.data.details === undefined,
  };
}

function oneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "The result could not be shown as text.";
  }
}
