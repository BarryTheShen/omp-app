import type { AppClient } from "@omp-app/client";
import { AppFailure, AppPort } from "@omp-app/contracts";

/** How often an open link is checked while the page is shown. */
const CHECK_EVERY_MS = 30_000;
/** How long the server's answer may take before the link counts as dead. */
export const ANSWER_WITHIN_MS = 15_000;
/** A page shown again, or a window focused again, checks at once unless it checked this recently. */
const RECHECK_AFTER_MS = 5_000;
/** A page away from the screen at least this long checks its link before anything else goes on it, when it is back. */
export const WAKE_AFTER_MS = 5_000;
/**
 * How long a link may take to answer when the page is back: a live one answers within a round trip, also on mobile data,
 * and calls made meanwhile wait for it (#2808).
 */
export const WAKE_ANSWER_WITHIN_MS = 4_000;

/**
 * Keeps the link's state true (#2789). A link can die without closing (a phone that slept, a relay that dropped it), and
 * the page would show it connected for minutes. While the page is shown, the app asks the server how it is every 30
 * seconds, and at once when the page is shown again, the window is focused again or the device is back online. No answer
 * in time drops the link for a new one; any answer, an error included, shows the link works. A page back on the screen
 * after 5 seconds or more away checks before anything else goes on the link, with 4 seconds for the answer: a message
 * sent at once waits for that, instead of going into a dead link (#2808). Returns what stops it.
 */
export function watchLink(client: AppClient): () => void {
  let checking = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let hiddenAt: number | null = null;
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
  const onVisibility = (): void => {
    if (document.visibilityState !== "visible") {
      hiddenAt ??= Date.now();
      return;
    }
    // Wall-clock time: a suspended page's own clock may not count the time it was asleep.
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (away >= WAKE_AFTER_MS && client.connectionState === "open") {
      checkedAt = performance.now();
      void client.checkLink(WAKE_ANSWER_WITHIN_MS);
      return;
    }
    again();
  };
  const timer = setInterval(check, CHECK_EVERY_MS);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", again);
  window.addEventListener("online", check);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", again);
    window.removeEventListener("online", check);
  };
}
