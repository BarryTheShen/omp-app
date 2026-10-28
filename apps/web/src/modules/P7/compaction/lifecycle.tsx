import type { Omp } from "@omp-app/contracts";

function actionText(action: Omp.AutoCompactionAction): string {
  switch (action) {
    case "context-full":
      return "making room in the conversation";
    case "remote":
      return "creating a remote summary";
    case "handoff":
      return "preparing a handoff summary";
    case "shake":
      // omp: "Surgically reduce context by dropping heavy content" (session-maintenance.ts:884, v18.12.6).
      return "dropping heavy content (old tool output, images and thinking) to free space";
    case "snapcompact":
      // omp: renders the discarded history as images; no model call, no summary (docs/compaction.md).
      return "archiving the older conversation as images instead of a summary";
  }
}

function reasonText(reason: Omp.AutoCompactionReason): string {
  switch (reason) {
    case "threshold":
      return "The conversation reached its compaction threshold.";
    case "overflow":
      return "The conversation reached its context limit.";
    case "idle":
      return "The conversation was compacted while idle.";
    case "incomplete":
      return "The previous response left work to finish.";
  }
}

export function AutomaticCompactionProgress({
  event,
}: {
  readonly event: Omp.AutoCompactionStartEvent;
}) {
  return (
    <p
      aria-live="polite"
      className="text-muted-foreground text-sm"
      data-p7-auto-compaction="running"
      role="status"
    >
      Automatic compaction is in progress. omp is {actionText(event.action)}.{" "}
      {reasonText(event.reason)}
    </p>
  );
}

export function AutomaticCompactionOutcome({
  event,
}: {
  readonly event: Omp.AutoCompactionEndEvent;
}) {
  if (event.aborted) {
    return (
      <p
        aria-live="polite"
        className="text-muted-foreground text-sm"
        data-p7-auto-compaction="aborted"
        role="status"
      >
        Automatic compaction was cancelled. Your conversation is still here.
      </p>
    );
  }

  if (event.skipped) {
    return (
      <p
        aria-live="polite"
        className="text-muted-foreground text-sm"
        data-p7-auto-compaction="skipped"
        role="status"
      >
        Automatic compaction was skipped. Your conversation is unchanged.
      </p>
    );
  }

  if (event.errorMessage !== undefined || event.willRetry) {
    const message = event.willRetry
      ? `Automatic compaction could not finish. omp will try again.${event.errorMessage ? ` ${event.errorMessage}` : ""}`
      : `Automatic compaction could not finish. Your conversation is still here.${event.errorMessage ? ` ${event.errorMessage}` : ""}`;
    return (
      <p
        aria-live="polite"
        className={event.willRetry ? "text-warning text-sm" : "text-destructive text-sm"}
        data-p7-auto-compaction={event.willRetry ? "warning" : "error"}
        role={event.willRetry ? "status" : "alert"}
      >
        {message}
      </p>
    );
  }

  return (
    <p
      aria-live="polite"
      className="text-muted-foreground text-sm"
      data-p7-auto-compaction="completed"
      role="status"
    >
      Automatic compaction finished. The conversation summary is available below.
    </p>
  );
}

export function CacheWarmingNotice({
  event,
}: {
  readonly event: Omp.CacheWarmingStartEvent | Omp.CacheWarmingEndEvent;
}) {
  if (event.type === "cache_warming_start") {
    return (
      <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
        omp is refreshing the prompt cache for the next response.
      </p>
    );
  }

  switch (event.outcome) {
    case "hit":
      return (
        <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
          The prompt cache is ready.
        </p>
      );
    case "miss":
      return (
        <p aria-live="polite" className="text-warning text-sm" role="status">
          The prompt cache was not available for the next response.
        </p>
      );
    case "error":
      return (
        <p aria-live="polite" className="text-destructive text-sm" role="alert">
          omp could not refresh the prompt cache.
        </p>
      );
    case "aborted":
      return (
        <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
          Prompt cache refresh was cancelled.
        </p>
      );
  }
}
