import { EmptyState, InlineError, Section } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { PanelFocusToken, PanelOpenReason, PanelState } from "@/modules/U5/panel/contract";
import { PanelShell } from "@/modules/U5/panel/shell";
import type { WorkersPanelSnapshot } from "./controller";
import type { WorkerRowModel } from "./model";

export interface WorkersPanelViewProps {
  readonly open: boolean;
  readonly position: PanelState["position"];
  readonly snapshot: WorkersPanelSnapshot;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
  readonly onRetry: () => void;
  readonly onStop: (id: string) => void;
  /** Placement opens a worker's transcript read-only; without it the transcript control says why it is off. */
  readonly onOpenTranscript?: (id: string) => void;
}

function WorkerActions({
  row,
  onStop,
  onOpenTranscript,
}: {
  readonly row: WorkerRowModel;
  readonly onStop: (id: string) => void;
  readonly onOpenTranscript: ((id: string) => void) | undefined;
}) {
  const transcriptReason =
    row.transcript.state === "unavailable"
      ? row.transcript.reason
      : onOpenTranscript === undefined
        ? "Open the transcript from the chat to read it here."
        : undefined;
  return (
    <div className="flex shrink-0 gap-1">
      <Button
        disabled={transcriptReason !== undefined}
        size="sm"
        title={transcriptReason}
        type="button"
        variant="outline"
        onClick={() => onOpenTranscript?.(row.id)}
      >
        View transcript
      </Button>
      {row.stop.state === "hidden" ? null : (
        <Button
          aria-label={row.stop.state === "stopping" ? `Stopping ${row.title}` : `Stop ${row.title}`}
          disabled={row.stop.state === "stopping"}
          size="sm"
          type="button"
          variant="destructive"
          onClick={() => onStop(row.id)}
        >
          {row.stop.state === "stopping" ? "Stopping..." : "Stop"}
        </Button>
      )}
    </div>
  );
}

function WorkerRow({
  row,
  onStop,
  onOpenTranscript,
}: {
  readonly row: WorkerRowModel;
  readonly onStop: (id: string) => void;
  readonly onOpenTranscript: ((id: string) => void) | undefined;
}) {
  const facts = [
    row.status.label,
    row.elapsed,
    row.step,
    row.toolCalls,
    row.model,
    row.usage,
    row.lineage,
  ].filter((fact): fact is string => fact !== null);
  // The facts wrap, not truncate: at 390 px the model, tokens and cost must stay visible (CC8).
  return (
    <div
      className="border-border/60 flex min-w-0 items-start justify-between gap-3 border-b py-3 last:border-b-0"
      data-slot="d8-worker-row"
      data-testid={`d8-worker-row-${row.id}`}
    >
      <div className="min-w-0 flex-1">
        <p className="min-w-0 break-words text-sm font-medium">{row.title}</p>
        <p className="text-muted-foreground min-w-0 break-words text-xs">{facts.join(" · ")}</p>
      </div>
      <WorkerActions row={row} onOpenTranscript={onOpenTranscript} onStop={onStop} />
    </div>
  );
}

function WorkersBody({
  snapshot,
  onRetry,
  onStop,
  onOpenTranscript,
}: {
  readonly snapshot: WorkersPanelSnapshot;
  readonly onRetry: () => void;
  readonly onStop: (id: string) => void;
  readonly onOpenTranscript: ((id: string) => void) | undefined;
}) {
  const { rows } = snapshot.model;
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4">
      {snapshot.error === null ? null : <InlineError message={snapshot.error} onRetry={onRetry} />}
      <Section heading="Side-task workers" variant="plain">
        <EmptyState
          hint="omp does not report side-task workers to this app, so they cannot be started here yet."
          title="Side-task workers are not reported here"
          variant="compact"
        />
      </Section>
      <Section heading="Persistent workers" variant="plain">
        <EmptyState
          hint="omp does not report persistent workers to this app, so they cannot be started here yet."
          title="Persistent workers are not reported here"
          variant="compact"
        />
      </Section>
      <Section heading="Subagents" variant="plain">
        {rows.length === 0 ? (
          <EmptyState
            hint="Subagents that omp starts in this chat appear here."
            title="No subagents yet"
            variant="compact"
          />
        ) : (
          rows.map((row) => (
            <WorkerRow
              key={row.key}
              row={row}
              onOpenTranscript={onOpenTranscript}
              onStop={onStop}
            />
          ))
        )}
      </Section>
    </div>
  );
}

/** The panel's view. It takes data and callbacks only; placement and actions are decided by its caller. */
export function WorkersPanelView({
  open,
  position,
  snapshot,
  onOpenChange,
  onRetry,
  onStop,
  onOpenTranscript,
  invokingFocus,
  restoreFocus,
}: WorkersPanelViewProps) {
  const lifecycle: PanelState["lifecycle"] = snapshot.loading ? "loading" : "populated";
  const panelState: PanelState = {
    open,
    lifecycle,
    position,
    title: "Workers",
    description:
      "Subagents in this chat. Side-task and persistent workers are not reported to this app.",
    error: null,
    readOnly: false,
    pendingUpdates: 0,
  };
  const body = snapshot.loading ? null : (
    <WorkersBody
      snapshot={snapshot}
      onOpenTranscript={onOpenTranscript}
      onRetry={onRetry}
      onStop={onStop}
    />
  );
  return (
    <PanelShell
      body={body}
      className="min-w-0"
      invokingFocus={invokingFocus}
      onOpenChange={onOpenChange}
      onRetry={onRetry}
      restoreFocus={restoreFocus}
      state={panelState}
    />
  );
}
