import type { AppHealth } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { Icons } from "@/tokens";

/** How often the page asks the server whether its watches are open. The server retries about as often. */
const WATCH_POLL_MS = 10_000;

/**
 * A status line over the chat while the server cannot watch some files. Changes made outside the app do
 * not show until it can, so the person is told why instead of seeing nothing happen.
 */
export function WatchNotice({
  detail,
  onDismiss,
}: {
  readonly detail: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div
      aria-live="polite"
      className="text-warning flex min-w-0 items-start gap-(--space-xs) text-xs"
      data-watch-notice="true"
      role="status"
    >
      <Icons.warning aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span>{detail}</span>
      </div>
      <button
        className="shrink-0 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={onDismiss}
        type="button"
      >
        Dismiss
      </button>
    </div>
  );
}

/** The notice the server's health asks for: its own words while a watch is limited, otherwise nothing. */
export function watchNoticeFor(health: AppHealth): string | undefined {
  return health.code === "watch_limited" ? health.detail : undefined;
}

/**
 * The watch notice, read from the server on an interval. A failed read keeps the last answer: the
 * connection banner already says when the server cannot be reached.
 */
export function useWatchNotice(
  readHealth: (() => Promise<AppHealth>) | undefined,
  intervalMs = WATCH_POLL_MS,
): { readonly detail: string | undefined; readonly dismiss: () => void } {
  const [notice, setNotice] = useState<string>();
  const [dismissed, setDismissed] = useState<string>();
  useEffect(() => {
    if (!readHealth) return;
    let active = true;
    const poll = () => {
      void readHealth().then(
        (health) => {
          if (!active) return;
          const nextNotice = watchNoticeFor(health);
          setNotice((previous) => (previous === nextNotice ? previous : nextNotice));
          setDismissed((previous) => (previous === nextNotice ? previous : undefined));
        },
        () => undefined,
      );
    };
    poll();
    const timer = window.setInterval(poll, intervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [readHealth, intervalMs]);
  return {
    detail: notice === dismissed ? undefined : notice,
    dismiss: () => {
      if (notice !== undefined) setDismissed(notice);
    },
  };
}
