import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { decodeResolve, decodeResolveArgs } from "./models";

type ResolveStatus = "approved" | "rejected" | "cancelled" | "error" | "pending" | "unrecorded";

export function ResolveCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const state = normalizeToolRendererProps(rendererProps);
  const output = state.result ?? state.partialResult;
  const envelope =
    output !== null && typeof output === "object" && !Array.isArray(output) ? output : undefined;
  const detailsSource = envelope !== undefined && "details" in envelope ? envelope.details : output;
  const decoded = decodeResolve(detailsSource);
  const details = decoded.ok ? decoded.value : undefined;
  const requested = decodeResolveArgs(state.args);
  const rejectedTool = state.toolName === "reject";
  const hasRecordedResult = state.result !== undefined;
  const action =
    details?.action ??
    (hasRecordedResult
      ? rejectedTool
        ? "discard"
        : "apply"
      : requested.ok && requested.value.action !== undefined
        ? requested.value.action
        : rejectedTool
          ? "discard"
          : "apply");
  const label = details?.label ?? "the staged change";
  const source = details?.sourceToolName ?? "staged change";
  const status = resolveStatus(state.phase, rejectedTool, details?.action);
  const reason =
    details?.reason ??
    (hasRecordedResult
      ? "No reason provided."
      : requested.ok && requested.value.reason !== undefined
        ? requested.value.reason
        : state.phase === "running"
          ? "Waiting for the staged decision."
          : "No reason provided.");
  const summary =
    hasRecordedResult &&
    (state.phase === "success" || state.phase === "error" || state.phase === "cancelled")
      ? `${action === "discard" ? "Discarded" : "Applied"}: ${label}`
      : `${action === "discard" ? "Discard" : "Apply"} the staged change`;
  const hideRawDetails =
    state.phase === "running" || state.phase === "partial"
      ? "[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
      : undefined;

  return (
    <div data-testid={`t7-resolve-card-${state.toolCallId}`}>
      <ToolCard
        className={hideRawDetails}
        rawResult={rawText(state.result ?? state.partialResult)}
        state={state}
        summary={summary}
      >
        <section
          aria-label={`${status} staged action`}
          className={`py-2 text-foreground ${statusTone(status)}`}
          data-status={status}
          data-testid={`t7-resolve-status-${state.toolCallId}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`text-sm font-medium ${statusTextTone(status)}`}>
              {statusLabel(status, action)}
            </span>
            <span className="text-muted-foreground pe-1 text-xs">Source: {source}</span>
          </div>
          <p className="text-foreground mt-1 text-xs">{reason}</p>
          {!decoded.ok &&
            output !== undefined &&
            state.phase !== "running" &&
            state.phase !== "partial" && (
              <p className="text-destructive mt-2 text-xs font-medium" role="alert">
                Resolve details were malformed; the raw result remains available above.
              </p>
            )}
        </section>
      </ToolCard>
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
  if (phase === "cancelled") return "cancelled";
  if (phase === "error") return "error";
  if (phase === "unrecorded") return "unrecorded";
  return rejectedTool || action === "discard" ? "rejected" : "approved";
}

function statusLabel(status: ResolveStatus, action: "apply" | "discard"): string {
  if (status === "pending") return "Pending decision";
  if (status === "unrecorded") return "No result recorded";
  if (status === "cancelled") return "Cancelled";
  if (status === "error")
    return action === "discard"
      ? "Could not discard the staged change."
      : "Could not apply the staged change.";
  return status === "approved" ? "Approved" : "Rejected";
}

function statusTone(status: ResolveStatus): string {
  if (status === "pending") return "border-warning/40";
  if (status === "approved") return "border-success/40";
  if (status === "unrecorded") return "border-border";
  return "border-destructive/40";
}

function statusTextTone(status: ResolveStatus): string {
  if (status === "pending") return "text-warning";
  if (status === "approved") return "text-success";
  if (status === "unrecorded") return "text-muted-foreground";
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
