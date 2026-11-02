import type { AppClient } from "@omp-app/client";
import { AppFailure, AppPort } from "@omp-app/contracts";

/** How often an open link is checked while the page is shown. */
const CHECK_EVERY_MS = 30_000;
/** How long the server's answer may take before the link counts as dead. */
export const ANSWER_WITHIN_MS = 15_000;
/** A page shown again, or a window focused again, checks at once unless it checked this recently. */
const RECHECK_AFTER_MS = 5_000;

/**
 * Keeps the link's state true (#2789). A link can die without closing (a phone that slept, a relay that dropped it), and
 * the page would show it connected for minutes. While the page is shown, the app asks the server how it is every 30
 * seconds, and at once when the page is shown again, the window is focused again or the device is back online. No answer
 * in time drops the link for a new one; any answer, an error included, shows the link works. Returns what stops it.
 */
export function watchLink(client: AppClient): () => void {
  let checking = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  const check = (): void => {
    if (checking || client.connectionState !== "open" || document.visibilityState !== "visible")
      return;
    checking = true;
    checkedAt = performance.now();
    client
      .port(AppPort)
      .health({}, { signal: AbortSignal.timeout(ANSWER_WITHIN_MS) })
      .catch((failure: unknown) => {
        // The time ran out (the call is cancelled then): nothing came back on this link.
        if (
          failure instanceof AppFailure &&
          failure.appError.code === "cancelled" &&
          client.connectionState === "open"
        )
          client.reconnectNow();
      })
      .finally(() => {
        checking = false;
      });
  };
  const again = (): void => {
    if (performance.now() - checkedAt >= RECHECK_AFTER_MS) check();
  };
  const timer = setInterval(check, CHECK_EVERY_MS);
  document.addEventListener("visibilitychange", again);
  window.addEventListener("focus", again);
  window.addEventListener("online", check);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", again);
    window.removeEventListener("focus", again);
    window.removeEventListener("online", check);
  };
}
