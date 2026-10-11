import type { AppHealth } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { Icons } from "@/tokens";

/** How often the page asks the server whether its watches are open. The server retries about as often. */
const WATCH_POLL_MS = 10_000;

/**
 * A status line over the chat while the server cannot watch some files. Changes made outside the app do
 * not show until it can, so the person is told why instead of seeing nothing happen.
 */
export function WatchNotice({ detail }: { readonly detail: string }) {
  return (
    <div
      aria-live="polite"
      className="text-warning flex min-w-0 items-start gap-(--space-xs) text-xs"
      data-watch-notice="true"
      role="status"
    >
      <Icons.warning aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">{detail}</span>
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
): string | undefined {
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (!readHealth) return;
    let active = true;
    const poll = () => {
      void readHealth().then(
        (health) => {
          if (active) setNotice(watchNoticeFor(health));
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
  return notice;
}
