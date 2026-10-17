import type { AppError } from "@omp-app/contracts";
import { InlineError } from "@/components/blocks";

export interface HistoryLoadFailureNoticeProps {
  readonly error: AppError;
  readonly onRetry: () => Promise<void>;
}

/** Keeps a failed history reload visible in an open thread and offers another read. */
export function HistoryLoadFailureNotice({ error, onRetry }: HistoryLoadFailureNoticeProps) {
  return (
    <InlineError
      heading="Earlier messages could not be loaded."
      message={error.message}
      onRetry={onRetry}
      retryLabel="Try again"
      variant="boxed"
    />
  );
}
