import { useId } from "react";
import { InlineError, Section } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { HubFact, HubInspector } from "./model";
import { StatusChip } from "./status-chip";

export interface WorkerInspectorProps {
  readonly inspector: HubInspector;
  readonly onCancel: (key: string) => void;
  readonly onOpenTranscript: (key: string) => void;
}

function FactList({ facts }: { readonly facts: readonly HubFact[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {facts.map((fact) => (
        <div className="contents" key={fact.label}>
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="min-w-0 truncate" title={fact.value}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The Cancel button, while a running worker can be cancelled. */
function CancelButton({
  inspector,
  onCancel,
}: {
  readonly inspector: HubInspector;
  readonly onCancel: (key: string) => void;
}) {
  const cancel = inspector.cancel;
  if (cancel.state === "ready") {
    return (
      <Button
        aria-label={`Cancel ${inspector.title}`}
        onClick={() => onCancel(inspector.key)}
        size="sm"
        variant="outline"
      >
        Cancel
      </Button>
    );
  }
  if (cancel.state === "sending") {
    return (
      <Button aria-busy="true" disabled size="sm" variant="outline">
        Cancelling…
      </Button>
    );
  }
  return null;
}

/** What the last cancel did, in plain words, under the action row. */
function CancelNotice({
  inspector,
  onCancel,
}: {
  readonly inspector: HubInspector;
  readonly onCancel: (key: string) => void;
}) {
  const cancel = inspector.cancel;
  switch (cancel.state) {
    case "hidden":
    case "ready":
    case "sending":
      return null;
    case "sent":
      return (
        <p className="text-muted-foreground text-xs" role="status">
          Cancel sent. Waiting for the worker to stop.
        </p>
      );
    case "failed":
      return (
        <InlineError
          message={cancel.message}
          onRetry={cancel.retryable ? () => onCancel(inspector.key) : undefined}
          variant="message"
        />
      );
    case "ended":
      return <p className="text-muted-foreground text-sm">{cancel.message}</p>;
    case "unavailable":
      return (
        <p className="text-muted-foreground text-xs">Cancel is not available: {cancel.reason}</p>
      );
  }
}

/**
 * The selected worker's details. Its name and status lead, then the actions, so a long inspector
 * never hides the action the reader came for.
 */
export function WorkerInspector({ inspector, onCancel, onOpenTranscript }: WorkerInspectorProps) {
  const reasonId = useId();
  const transcript = inspector.transcript;
  return (
    <Section heading="Selected worker" headingLevel={3} variant="plain">
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" title={inspector.title}>
              {inspector.title}
            </p>
            <p className="text-muted-foreground truncate text-xs" title={inspector.subtitle}>
              {inspector.subtitle}
            </p>
          </div>
          <StatusChip presentation={inspector.status} />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <CancelButton inspector={inspector} onCancel={onCancel} />
            <Button
              aria-describedby={transcript.state === "available" ? undefined : reasonId}
              disabled={transcript.state !== "available"}
              onClick={() => onOpenTranscript(inspector.key)}
              size="sm"
              variant="outline"
            >
              Open transcript
            </Button>
          </div>
          <CancelNotice inspector={inspector} onCancel={onCancel} />
          {transcript.state === "unavailable" ? (
            <p className="text-muted-foreground text-xs" id={reasonId}>
              {transcript.reason}
            </p>
          ) : null}
        </div>
        {inspector.step ? (
          <p className="text-xs">
            <span className="text-muted-foreground">Current step: </span>
            {inspector.step}
          </p>
        ) : null}
        <FactList facts={inspector.facts} />
        {inspector.progress.length > 0 ? (
          <div className="flex flex-col gap-1">
            <h4 className="text-muted-foreground text-xs font-medium">Progress</h4>
            <FactList facts={inspector.progress} />
          </div>
        ) : null}
        {inspector.task ? (
          <div className="flex flex-col gap-1">
            <h4 className="text-muted-foreground text-xs font-medium">Task</h4>
            <p className="max-h-24 overflow-y-auto text-xs whitespace-pre-wrap">{inspector.task}</p>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
