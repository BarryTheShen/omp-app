import { useId } from "react";
import { EmptyState, InlineError } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type {
  P3PreviousMessageSelectorActions,
  P3PreviousMessageSelectorViewModel,
} from "./controller";

const TURN_RUNNING_REASON = "Wait for this chat's turn to finish, then edit an earlier message.";

export interface PreviousMessageSelectorViewProps {
  readonly viewModel: P3PreviousMessageSelectorViewModel;
  readonly actions: P3PreviousMessageSelectorActions;
  readonly running: boolean;
}

/** A placement-free trigger and status surface for editing an earlier user message. */
export function PreviousMessageSelectorView({
  viewModel,
  actions,
  running,
}: PreviousMessageSelectorViewProps) {
  const reasonId = useId();
  // omp lacks `get_branch_messages` or `branch`: the action is not offered (AP2, AP6).
  if (viewModel.state === "unavailable") return null;
  const requestBusy = viewModel.state === "loading" || viewModel.state === "opening";
  // A failure that cannot be retried leaves the trigger off for good.
  const disabled = !running && viewModel.state === "error" && !viewModel.retryable;
  return (
    <div
      aria-busy={requestBusy}
      className="flex min-w-0 flex-col gap-2"
      data-slot="p3-previous-message-selector"
    >
      <Button
        type="button"
        variant="ghost"
        className="border-0 text-muted-foreground hover:text-foreground rounded-control h-7 self-start px-2 text-sm font-normal transition-colors"
        size="sm"
        aria-disabled={running || requestBusy}
        aria-describedby={running ? reasonId : undefined}
        title={running ? TURN_RUNNING_REASON : undefined}
        disabled={disabled}
        onClick={(event) => {
          if (running) return;
          actions.onOpen(event.currentTarget);
        }}
      >
        Edit an earlier message
      </Button>
      {running ? (
        <span id={reasonId} className="sr-only">
          {TURN_RUNNING_REASON}
        </span>
      ) : null}
      {viewModel.state === "loading" ? (
        <p className="text-muted-foreground text-sm" role="status">
          Loading earlier messages…
        </p>
      ) : null}
      {viewModel.state === "opening" ? (
        <p className="text-muted-foreground text-sm" role="status">
          Opening the message…
        </p>
      ) : null}
      {viewModel.state === "empty" ? (
        <EmptyState title="No earlier messages to edit." variant="compact" />
      ) : null}
      {viewModel.state === "error" ? (
        <InlineError
          message={viewModel.message}
          onRetry={viewModel.retryable && !running ? actions.onRetry : undefined}
          retryLabel="Try again"
          variant="compact"
        />
      ) : null}
    </div>
  );
}
