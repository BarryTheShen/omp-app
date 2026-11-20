import type { AppClient } from "@omp-app/client";
import { AppPort, type ClientTraceReport } from "@omp-app/contracts";
import { clientTags } from "./perf/frames";
import { reloadKeepingChat } from "./reloadKeepsChat";

/**
 * A page whose link stays down while its server answers: its own connection is stuck, and only a new page gets through.
 * Seen on an iPhone's Home Screen app and in the desktop window (2026-11-20): after a drop, the page's new links never
 * reached the server, Reconnect now did nothing, and swiping the app away or reopening the window was the only way back.
 * So a page whose link has been down this long while shown, and whose server answers a plain request, reloads itself,
 * keeping its chat; and Reconnect now reloads when its new link has not come up this soon.
 */
export const STUCK_AFTER_MS = 15_000;
export const BUTTON_WAITS_MS = 6_000;
/** A page reloads itself at most once in this long, so a link that fails for another reason never loops. */
export const RESCUE_AT_MOST_EVERY_MS = 3 * 60_000;
/** How long the server's answer to the plain request may take. */
const PROBE_WITHIN_MS = 5_000;
const KEY = "omp-app:link-rescue";

interface Rescue {
  readonly at: number;
  readonly downMs: number;
  readonly how: "stuck" | "button";
}

function lastRescue(): Rescue | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Rescue | null;
    return saved !== null && typeof saved.at === "number" ? saved : null;
  } catch {
    return null;
  }
}

/** What the probe needs of `fetch`. */
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Whether the server answers a plain request: the page's own address, never cached. */
export async function serverAnswers(fetcher: Fetcher = fetch): Promise<boolean> {
  try {
    const answer = await fetcher(window.location.pathname, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_WITHIN_MS),
    });
    return answer.ok;
  } catch {
    return false;
  }
}

/**
 * Reloads the page when the server answers while its link does not; false (no reload) when the server does not answer
 * either (it is down, or the device is offline: a reload would not help), or when the page reloaded for this lately.
 */
export async function rescueIfServerAnswers(
  how: Rescue["how"],
  downMs: number,
  options: {
    readonly fetcher?: Fetcher;
    readonly reload?: () => void;
    readonly now?: () => number;
  } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const last = lastRescue();
  if (how === "stuck" && last !== null && now() - last.at < RESCUE_AT_MOST_EVERY_MS) return false;
  if (!(await serverAnswers(options.fetcher))) return false;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ at: now(), downMs, how } satisfies Rescue));
  } catch {
    // No session storage: the reload goes ahead, unreported.
  }
  (options.reload ?? reloadKeepingChat)();
  return true;
}

/**
 * Reconnect now: a new link at once; when it is not up within 6 seconds and the server answers, the page reloads, as
 * the person would by reopening the app.
 */
export function reconnectOrReload(client: AppClient): void {
  const since = Date.now();
  client.reconnectNow();
  window.setTimeout(() => {
    if (client.connectionState !== "open") void rescueIfServerAnswers("button", Date.now() - since);
  }, BUTTON_WAITS_MS);
}

/** The trace a page sends once its link is up after it reloaded for a stuck link. */
export function rescueTrace(rescue: Rescue, upMs: number): ClientTraceReport {
  return {
    marks: { down_ms: rescue.downMs, up_after_reload_ms: upMs },
    gaps: [],
    supported: ["link-rescue", rescue.how, ...clientTags()],
  };
}

/**
 * Watches for a stuck link (down 15 seconds while the page is shown) and reloads the page when its server answers. A
 * page loaded by such a reload tells the server's debug log once its link is up. Returns what stops it.
 */
export function watchStuckLink(client: AppClient): () => void {
  const loadedAt = performance.now();
  const rescued = lastRescue();
  let told = rescued === null || Date.now() - rescued.at > RESCUE_AT_MOST_EVERY_MS;
  /** When the link went down while the page was shown (or the page was shown again with it down). */
  let downSince: number | null = null;
  let timer: number | undefined;
  const arm = (): void => {
    window.clearTimeout(timer);
    if (downSince === null || document.visibilityState !== "visible") return;
    const wait = Math.max(0, downSince + STUCK_AFTER_MS - Date.now());
    timer = window.setTimeout(() => {
      if (client.connectionState === "open" || downSince === null) return;
      void rescueIfServerAnswers("stuck", Date.now() - downSince).then((reloading) => {
        // The server did not answer: tried again after another wait.
        if (!reloading && downSince !== null) {
          downSince = Date.now();
          arm();
        }
      });
    }, wait);
  };
  const stopState = client.onConnectionState((event) => {
    if (event.state === "open") {
      downSince = null;
      window.clearTimeout(timer);
      if (!told && rescued !== null) {
        told = true;
        client
          .port(AppPort)
          .reportClientTrace(rescueTrace(rescued, Math.round(performance.now() - loadedAt)))
          .catch(() => undefined);
      }
      return;
    }
    // Only a link that was up and went down: a refused or closed link is the banner's (Reload, or a pairing).
    if (event.state !== "reconnecting") return;
    downSince ??= Date.now();
    arm();
  });
  const onVisibility = (): void => {
    if (document.visibilityState !== "visible") {
      window.clearTimeout(timer);
      return;
    }
    // Time away does not count: the page's link gets its chance to come back first.
    if (downSince !== null) downSince = Date.now();
    arm();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    stopState();
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
