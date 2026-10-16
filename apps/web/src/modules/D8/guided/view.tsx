import { useId } from "react";
import { InlineError, Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { GuidedGoalSnapshot } from "./controller";

export interface GuidedGoalViewProps {
  readonly snapshot: GuidedGoalSnapshot;
  readonly onStart: () => void;
  readonly onRetry: () => void;
}

const DESCRIPTION =
  "omp asks you questions in dialogs, shows the goal for review, and creates it only when you confirm.";

export function GuidedGoalView({ snapshot, onStart, onRetry }: GuidedGoalViewProps) {
  const headingId = useId();
  const createReasonId = useId();
  const { status, notice, error, createReason } = snapshot;
  const busy = status === "interviewing" || status === "creating";
  const startDisabled = busy || createReason !== null;
  const startLabel =
    status === "cancelled" || status === "failed"
      ? "Start again"
      : status === "interviewing"
        ? "Interview in progress"
        : status === "creating"
          ? "Creating goal…"
          : "Start guided goal";
  const start = () => {
    if (!startDisabled) onStart();
  };

  return (
    <Section description={DESCRIPTION} heading="Guided goal" headingId={headingId} variant="plain">
      <div className="flex flex-col gap-3">
        {status === "interviewing" ? (
          <p className="text-muted-foreground text-sm" id={createReasonId} role="status">
            Answer the questions in the dialog. Nothing is created until you confirm.
          </p>
        ) : null}
        {status === "creating" ? (
          <p className="text-muted-foreground text-sm" id={createReasonId} role="status">
            Creating the goal…
          </p>
        ) : null}
        {notice !== null ? (
          <p className="text-muted-foreground text-sm" role="status">
            {notice}
          </p>
        ) : null}
        {createReason !== null && !busy ? (
          <p className="text-muted-foreground text-sm" id={createReasonId} role="status">
            {createReason}
          </p>
        ) : null}
        {status === "failed" && error !== null ? (
          <InlineError
            message={error.message}
            onRetry={error.retryable ? onRetry : undefined}
            retryLabel="Try again"
          />
        ) : null}
        <Toolbar ariaLabel="Guided goal actions">
          <Button
            aria-describedby={busy || createReason !== null ? createReasonId : undefined}
            aria-disabled={startDisabled}
            className={
              startDisabled
                ? "aria-disabled:pointer-events-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-primary aria-disabled:hover:text-primary-foreground aria-disabled:active:translate-y-0"
                : undefined
            }
            data-testid="guided-start"
            onClick={start}
            type="button"
          >
            {startLabel}
          </Button>
        </Toolbar>
      </div>
    </Section>
  );
}
