import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { decodeResolve } from "./models";

type ResolveStatus = "approved" | "rejected" | "pending";

export function ResolveCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const state = normalizeToolRendererProps(rendererProps);
  const decoded = decodeResolve(state.result ?? state.partialResult);
  const details = decoded.ok ? decoded.value : undefined;
  const rejectedTool = state.toolName === "reject";
  const status = resolveStatus(state.phase, rejectedTool, details?.action);
  const action = details?.action ?? (rejectedTool ? "discard" : "apply");
  const source = details?.sourceToolName ?? details?.label ?? "host action";
  const reason =
    details?.reason ??
    (state.phase === "running" ? "Waiting for the staged decision." : "No reason provided.");

  const hideRawDetails =
    state.phase === "running" || state.phase === "partial"
      ? "[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden"
      : undefined;

  return (
    <div data-testid={`t7-resolve-card-${state.toolCallId}`}>
      <ToolCard
        className={hideRawDetails}
        rawResult={rawText(state.result ?? state.partialResult)}
        state={state}
        summary={`${action} · ${source}`}
      />
      <section
        aria-label={`${status} staged action`}
        className={`ms-2 border-s-2 border-border/70 bg-card py-2 pe-4 ps-4 text-foreground ${statusTone(status)}`}
        data-status={status}
        data-testid={`t7-resolve-status-${state.toolCallId}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={`text-sm font-medium ${statusTextTone(status)}`}>
            {statusLabel(status)}
          </span>
          <span className="text-muted-foreground pe-1 text-xs">Source: {source}</span>
        </div>
        <p className="text-foreground mt-1 text-xs">{reason}</p>
        {state.phase === "error" && (
          <p className="text-destructive mt-2 text-xs font-medium" role="alert">
            The staged action failed; it was not accepted.
          </p>
        )}
        {!decoded.ok && state.phase !== "running" && state.phase !== "partial" && (
          <p className="text-destructive mt-2 text-xs font-medium" role="alert">
            Resolve details were malformed; the raw result remains available above.
          </p>
        )}
      </section>
    </div>
  );
}

export const ResolveToolRenderer: ToolRenderer = (props) => <ResolveCard rendererProps={props} />;

function resolveStatus(
  phase: string,
  rejectedTool: boolean,
  action: "apply" | "discard" | undefined,
): ResolveStatus {
  if (phase === "running" || phase === "partial") return "pending";
  if (phase === "error" || phase === "cancelled") return "rejected";
  return rejectedTool || action === "discard" ? "rejected" : "approved";
}

function statusLabel(status: ResolveStatus): string {
  if (status === "pending") return "Pending decision";
  return status === "approved" ? "Approved" : "Rejected";
}

function statusTone(status: ResolveStatus): string {
  if (status === "pending") return "border-warning/40";
  if (status === "approved") return "border-success/40";
  return "border-destructive/40";
}

function statusTextTone(status: ResolveStatus): string {
  if (status === "pending") return "text-warning";
  if (status === "approved") return "text-success";
  return "text-destructive";
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[Unserializable resolve result]";
  }
}
