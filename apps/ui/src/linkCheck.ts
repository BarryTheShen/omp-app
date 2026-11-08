import type { AppClient, OutageReport } from "@omp-app/client";
import {
  AppFailure,
  AppPort,
  type ClientTraceReport,
  LINK_SILENCE_LIMIT_SECONDS,
} from "@omp-app/contracts";
import { clientTags } from "./perf/frames";

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
/** A page away at least this long has a link the server already closed: it reconnects without checking first. */
export const SURELY_CLOSED_AFTER_MS = LINK_SILENCE_LIMIT_SECONDS * 1_000;
/** The page looks at the clock this often; a look this much later than due means the device slept in between. */
export const TICK_MS = 5_000;
export const SLEPT_AFTER_MS = 15_000;
/** A return this recent is told with the outage that followed it, in the link trace. */
const RETURN_TOLD_WITHIN_MS = 60_000;

/** The page's last return: shown again after being hidden, or awake after the device slept. */
interface Return {
  readonly at: number;
  readonly awayMs: number;
  readonly how: "shown" | "awake";
}

/** When the page last came back (`Date.now()`), and who wants to know: the banner waits longer right after one. */
let returnedAt: number | null = null;
const returnListeners = new Set<() => void>();

/** The time the page last came back (shown again, or awake after a sleep), or null if it has not. */
export function lastReturnAt(): number | null {
  return returnedAt;
}

/** Calls `listener` each time the page comes back; returns what stops it. */
export function onReturn(listener: () => void): () => void {
  returnListeners.add(listener);
  return () => {
    returnListeners.delete(listener);
  };
}

/**
 * Keeps the link's state true and brings it back quickly (#2789). A link can die without closing (a phone that slept, a
 * relay that dropped it), and the page would show it connected for minutes. While the page is shown, the app asks the
 * server how it is every 30 seconds, and at once when the page is shown again, the window is focused again or the device
 * is back online. No answer in time drops the link for a new one; any answer, an error included, shows the link works.
 *
 * A page back after being away (hidden, or the device asleep, told by a clock that jumped): away longer than the server
 * keeps a silent link, it reconnects at once, as that link is surely closed; away 5 seconds or more, it checks before
 * anything else goes on the link, with 4 seconds for the answer, so a message sent at once waits for that instead of
 * going into a dead link (#2808). While the link is down, each of these signs (and being back online) sends a reconnect
 * that waits for its next try at once. Each outage is reported to the server's debug log as a `link` trace. Returns what
 * stops it.
 */
export function watchLink(client: AppClient): () => void {
  let checking = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let hiddenAt: number | null = null;
  let lastReturn: Return | null = null;
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
          client.reconnectNow("no-answer");
      })
      .finally(() => {
        checking = false;
      });
  };
  const again = (): void => {
    if (client.connectionState !== "open") {
      client.nudge();
      return;
    }
    if (performance.now() - checkedAt >= RECHECK_AFTER_MS) check();
  };
  /** The page is back after `awayMs` away. */
  const cameBack = (awayMs: number, how: Return["how"]): void => {
    lastReturn = { at: Date.now(), awayMs, how };
    returnedAt = lastReturn.at;
    for (const listener of [...returnListeners]) listener();
    if (client.connectionState !== "open") {
      client.nudge();
      return;
    }
    if (awayMs >= SURELY_CLOSED_AFTER_MS) {
      checkedAt = performance.now();
      client.reconnectNow("away");
      return;
    }
    if (awayMs >= WAKE_AFTER_MS) {
      checkedAt = performance.now();
      void client.checkLink(WAKE_ANSWER_WITHIN_MS);
      return;
    }
    again();
  };
  const onVisibility = (): void => {
    if (document.visibilityState !== "visible") {
      hiddenAt ??= Date.now();
      return;
    }
    // Wall-clock time: a suspended page's own clock may not count the time it was asleep.
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    cameBack(away, "shown");
  };
  let lastTick = Date.now();
  const tick = (): void => {
    const now = Date.now();
    const late = now - lastTick - TICK_MS;
    lastTick = now;
    // A hidden page's timers are slowed by the browser itself: only a shown page's late tick tells that the device slept.
    if (late >= SLEPT_AFTER_MS && document.visibilityState === "visible") cameBack(late, "awake");
  };
  const online = (): void => {
    client.nudge();
    check();
  };
  const stopOutages = client.onOutage((report) => {
    const recent =
      lastReturn !== null && Date.now() - lastReturn.at <= RETURN_TOLD_WITHIN_MS
        ? lastReturn
        : null;
    client
      .port(AppPort)
      .reportClientTrace(linkTrace(report, recent))
      .catch(() => undefined);
  });
  const checks = setInterval(check, CHECK_EVERY_MS);
  const ticks = setInterval(tick, TICK_MS);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", again);
  window.addEventListener("online", online);
  return () => {
    clearInterval(checks);
    clearInterval(ticks);
    stopOutages();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", again);
    window.removeEventListener("online", online);
  };
}

/** An outage as the server's debug log keeps it: what lost the link, how long each step took, and the return before. */
export function linkTrace(report: OutageReport, recent: Return | null): ClientTraceReport {
  return {
    marks: {
      outage_ms: report.outageMs,
      to_welcome_ms: report.toWelcomeMs,
      tries: report.tries,
      failed_tries: report.failedTries,
      stalled_tries: report.stalledTries,
      open_ms: report.openMs,
      welcome_ms: report.welcomeMs,
      streams: report.streams,
      resume_ms: report.resumeMs,
      ...(report.closeCode === undefined ? {} : { close_code: report.closeCode }),
      ...(recent === null ? {} : { away_ms: recent.awayMs }),
    },
    gaps: [],
    supported: ["link", report.cause, ...clientTags(), ...(recent === null ? [] : [recent.how])],
  };
}
