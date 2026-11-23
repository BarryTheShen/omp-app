/**
 * The page's own reloads (Reload, Reconnect's fallback, a new launch link, a pairing), watched. On an iPhone's Home
 * Screen app a reload could start and never finish: the page went away for the network (its new link closed "going
 * away") but stayed, its old link open, and stopped answering until the app was swiped away (the server's log,
 * 2026-11-22 20:59). So a reload tells the server's debug log as it starts; a page still here 8 seconds later says so
 * and navigates afresh (`location.replace` to the same address with a new `reload` mark); still here 20 seconds after
 * the start, it says so and asks the person to reopen the app rather than leave them on a page that does nothing. The
 * page the reload lands on tells how long it took, up to the app being up. A plain reload took 0.1 to 4.5 seconds on
 * that iPhone.
 */
import type { ClientTraceReport } from "@omp-app/contracts";
import { clientTags } from "./perf/frames";

const KEY = "omp-app:reload";
const RETRY_PARAM = "reload";
/** A page still here this long after its reload asked for it navigates afresh. */
export const RETRY_AFTER_MS = 8_000;
/** Still here this long after: the person is asked to reopen the app. */
export const GIVE_UP_AFTER_MS = 20_000;
/** What the page says when it could not reload. */
export const REOPEN_WORDS =
  "The app did not reload. Close it (on an iPhone, swipe it away) and open it again.";

interface Started {
  readonly at: number;
  readonly how: string;
  readonly retried?: boolean;
}

/** What a watched reload does to the page, given by the browser (`reloadPage`) or a test. */
export interface ReloadDeps {
  readonly reload: () => void;
  readonly replace: (href: string) => void;
  readonly href: () => string;
  readonly now: () => number;
  readonly later: (run: () => void, ms: number) => void;
  /** Keeps the start for the page it lands on (session storage). */
  readonly keep: (started: Started) => void;
  readonly tell: (stage: string, how: string, marks: Record<string, number>) => void;
  readonly askToReopen: () => void;
}

/** Starts a reload and watches it: a fresh navigation after 8 seconds, the person asked to reopen after 20. */
export function watchReload(how: string, deps: ReloadDeps): void {
  const at = deps.now();
  deps.keep({ at, how });
  deps.tell("start", how, {});
  deps.reload();
  deps.later(() => {
    deps.tell("stalled", how, { after_ms: deps.now() - at });
    deps.keep({ at, how, retried: true });
    const url = new URL(deps.href());
    url.searchParams.set(RETRY_PARAM, String(deps.now()));
    deps.replace(url.href);
    deps.later(() => {
      deps.tell("stuck", how, { after_ms: deps.now() - at });
      deps.askToReopen();
    }, GIVE_UP_AFTER_MS - RETRY_AFTER_MS);
  }, RETRY_AFTER_MS);
}

let sink: ((trace: ClientTraceReport) => void) | null = null;
const waiting: ClientTraceReport[] = [];

function tell(stage: string, how: string, marks: Record<string, number>): void {
  const trace: ClientTraceReport = {
    marks: {
      ...marks,
      online: navigator.onLine ? 1 : 0,
      visible: document.visibilityState === "visible" ? 1 : 0,
    },
    gaps: [],
    supported: ["reload", stage, how, ...clientTags()],
  };
  if (sink === null) waiting.push(trace);
  else sink(trace);
}

/** Says, for the person, that the page could not reload: on a page that does nothing else now. */
function askToReopen(): void {
  const note = document.createElement("div");
  note.setAttribute("role", "alert");
  note.className =
    "fixed inset-x-4 top-[calc(env(safe-area-inset-top)+0.5rem)] z-[1000] rounded-lg border border-l3 bg-raise p-3 text-sm text-t1 shadow-lg";
  note.textContent = REOPEN_WORDS;
  document.body.append(note);
}

/** Reloads the page, watched (see the file's head); `how` names who asked, for the log. */
export function reloadPage(how: string): void {
  watchReload(how, {
    reload: () => window.location.reload(),
    replace: (href) => window.location.replace(href),
    href: () => window.location.href,
    now: Date.now,
    later: (run, ms) => window.setTimeout(run, ms),
    keep: (started) => {
      try {
        sessionStorage.setItem(KEY, JSON.stringify(started));
      } catch {
        // No session storage: the reload goes ahead; the page it lands on cannot tell how long it took.
      }
    },
    tell,
    askToReopen,
  });
}

/**
 * Sends the reload traces to the server's debug log from now on (those of before first); on the page a reload landed
 * on, tells how long it took and takes the retry's mark off the address. Returns what stops it.
 */
export function traceReloads(report: (trace: ClientTraceReport) => void): () => void {
  sink = report;
  for (const trace of waiting.splice(0)) report(trace);
  try {
    const kept = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (kept !== null) {
      const started = JSON.parse(kept) as Started;
      tell("landed", started.how, {
        took_ms: Date.now() - started.at,
        retried: started.retried === true ? 1 : 0,
      });
    }
  } catch {
    // No session storage, or a mark that is not ours: nothing to tell.
  }
  const url = new URL(window.location.href);
  if (url.searchParams.has(RETRY_PARAM)) {
    url.searchParams.delete(RETRY_PARAM);
    window.history.replaceState(window.history.state, "", url.href);
  }
  return () => {
    if (sink === report) sink = null;
  };
}
