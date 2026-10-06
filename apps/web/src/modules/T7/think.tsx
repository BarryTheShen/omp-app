import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { decodeThink } from "./models";

/**
 * The thought is private: the card drops the arguments and shows only an acknowledgment.
 * It opens by default only on error, where the error banner is the content; otherwise the
 * open body would be empty while the call runs.
 */
export function ThinkCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const state = {
    ...normalized,
    args: undefined,
    argsText: "",
    defaultOpen: normalized.phase === "error",
  };
  const output = state.result ?? state.partialResult;
  // omp results carry structured data under `details`; bare detail objects pass through.
  const decoded = decodeThink(
    output !== null && typeof output === "object" && "details" in output ? output.details : output,
  );
  const details = decoded.ok ? decoded.value : undefined;
  const summary = thinkSummary(state.phase, details?.recorded, details?.status);

  return (
    <div data-testid={`t7-think-card-${state.toolCallId}`}>
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawText(output)}
        state={state}
        summary={summary}
      />
      <p className="text-muted-foreground ms-2 py-1 text-xs">The content stays private.</p>
    </div>
  );
}

export const ThinkToolRenderer: ToolRenderer = (props) => <ThinkCard rendererProps={props} />;

function thinkSummary(
  phase: string,
  recorded: boolean | undefined,
  status: "recorded" | "completed" | "error" | undefined,
): string {
  if (phase === "running" || phase === "partial") return "Recording private note…";
  if (phase === "error" || phase === "cancelled" || status === "error" || recorded === false) {
    return "Private note not recorded";
  }
  return "Private note recorded";
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[Unserializable think result]";
  }
}
