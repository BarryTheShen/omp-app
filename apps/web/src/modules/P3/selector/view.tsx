import { EmptyState, InlineError } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type {
  P3PreviousMessageSelectorActions,
  P3PreviousMessageSelectorViewModel,
} from "./controller";

export interface PreviousMessageSelectorViewProps {
  readonly viewModel: P3PreviousMessageSelectorViewModel;
  readonly actions: P3PreviousMessageSelectorActions;
}

/** A placement-free trigger and status surface for editing an earlier user message. */
export function PreviousMessageSelectorView({
  viewModel,
  actions,
}: PreviousMessageSelectorViewProps) {
  // omp lacks `get_branch_messages` or `branch`: the action is not offered (AP2, AP6).
  if (viewModel.state === "unavailable") return null;
  const busy = viewModel.state === "loading" || viewModel.state === "opening";
  // A failure that cannot be retried leaves the trigger off for good.
  const disabled = viewModel.state === "error" && !viewModel.retryable;

  return (
    <div
      aria-busy={busy}
      className="flex min-w-0 flex-col gap-2"
      data-slot="p3-previous-message-selector"
    >
      <Button
        type="button"
        variant="outline"
        aria-disabled={busy}
        disabled={disabled}
        onClick={(event) => actions.onOpen(event.currentTarget)}
      >
        Edit an earlier message
      </Button>
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
          onRetry={viewModel.retryable ? actions.onRetry : undefined}
          retryLabel="Try again"
          variant="compact"
        />
      ) : null}
    </div>
  );
}
