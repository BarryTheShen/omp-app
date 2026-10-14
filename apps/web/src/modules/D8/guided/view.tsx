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
  const { status, notice, error, createReason } = snapshot;
  const busy = status === "interviewing" || status === "creating";
  const startDisabled = busy || createReason !== null;

  return (
    <Section description={DESCRIPTION} heading="Guided goal" headingId={headingId} variant="plain">
      <div className="flex flex-col gap-3">
        {status === "interviewing" ? (
          <p className="text-muted-foreground text-sm" role="status">
            Answer the questions in the dialog. Nothing is created until you confirm.
          </p>
        ) : null}
        {status === "creating" ? (
          <p className="text-muted-foreground text-sm" role="status">
            Creating the goal…
          </p>
        ) : null}
        {notice !== null ? (
          <p className="text-muted-foreground text-sm" role="status">
            {notice}
          </p>
        ) : null}
        {createReason !== null && !busy ? (
          <p className="text-muted-foreground text-sm" role="status">
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
          {status === "idle" || status === "created" ? (
            <Button disabled={startDisabled} onClick={onStart} type="button">
              Start guided goal
            </Button>
          ) : null}
          {status === "cancelled" || status === "failed" ? (
            <Button disabled={startDisabled} onClick={onStart} type="button">
              Start again
            </Button>
          ) : null}
          {status === "interviewing" ? (
            <Button disabled type="button">
              Interview in progress
            </Button>
          ) : null}
          {status === "creating" ? (
            <Button disabled type="button">
              Creating goal…
            </Button>
          ) : null}
        </Toolbar>
      </div>
    </Section>
  );
}
