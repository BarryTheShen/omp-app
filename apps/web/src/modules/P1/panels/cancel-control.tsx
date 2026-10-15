import { InlineError } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { CancelControl } from "./model";

/** The Cancel button, while a running worker can be cancelled; "Cancelling…" while the call is sent. */
export function CancelButton({
  control,
  onCancel,
  title,
}: {
  readonly control: CancelControl;
  readonly onCancel: () => void;
  readonly title: string;
}) {
  if (control.state === "ready" || control.state === "refused") {
    return (
      <Button aria-label={`Cancel ${title}`} onClick={onCancel} size="sm" variant="outline">
        Cancel
      </Button>
    );
  }
  if (control.state === "sending") {
    return (
      <Button aria-busy="true" disabled size="sm" variant="outline">
        Cancelling…
      </Button>
    );
  }
  return null;
}

/** What the last cancel did, in plain words, under the action row. */
export function CancelNotice({
  control,
  onCancel,
}: {
  readonly control: CancelControl;
  readonly onCancel: () => void;
}) {
  switch (control.state) {
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
          message={control.message}
          onRetry={control.retryable ? onCancel : undefined}
          variant="message"
        />
      );
    case "ended":
      return <p className="text-muted-foreground text-sm">{control.message}</p>;
    case "refused":
      return (
        <p className="text-muted-foreground text-sm" role="status">
          {control.message}
        </p>
      );
    case "unavailable":
      return (
        <p className="text-muted-foreground text-xs">Cancel is not available: {control.reason}</p>
      );
  }
}
