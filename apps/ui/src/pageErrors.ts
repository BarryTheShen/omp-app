import type { ClientErrorReport } from "@omp-app/contracts";

/**
 * Sends what goes wrong in the page to the app's debug log (`A0.app.reportClientError`), so one debug report holds the
 * server's half and the page's. The server cuts, scrubs and rate-limits what arrives; this side keeps the page's own
 * loop in check, never sends the address's fragment or query (a launch link's token lives there), and never reports a
 * failure of reporting itself.
 */

export type PageErrorSink = (report: ClientErrorReport) => Promise<unknown>;

/** Reports made before the app has a connection wait here; the oldest are dropped past this. */
const MAX_WAITING = 20;
/** The same message again within this many ms is the same event repeating, not a new one. */
const REPEAT_WINDOW_MS = 1_000;
// The contract's limits (`ClientErrorReport`): a report over one of them would be refused whole.
const MESSAGE_MAX = 2_000;
const STACK_MAX = 8_000;
const PAGE_MAX = 300;

let sink: PageErrorSink | undefined;
const waiting: ClientErrorReport[] = [];
let lastMessage = "";
let lastAt = 0;

function send(report: ClientErrorReport): void {
  if (sink === undefined) {
    waiting.push(report);
    if (waiting.length > MAX_WAITING) waiting.shift();
    return;
  }
  // A failed report is dropped: reporting it would report the reporter, forever.
  void sink(report).catch(() => undefined);
}

/** Hands one error to the debug log, or holds it until the app has a connection. */
export function reportPageError(report: Omit<ClientErrorReport, "page">): void {
  const now = Date.now();
  if (report.message === lastMessage && now - lastAt < REPEAT_WINDOW_MS) return;
  lastMessage = report.message;
  lastAt = now;
  send({
    kind: report.kind,
    message: report.message.slice(0, MESSAGE_MAX),
    ...(report.stack === undefined ? {} : { stack: report.stack.slice(0, STACK_MAX) }),
    page: `${window.location.origin}${window.location.pathname}`.slice(0, PAGE_MAX),
  });
}

/** Where reports go once the app has a connection; `undefined` when that connection ends. */
export function setPageErrorSink(next: PageErrorSink | undefined): void {
  sink = next;
  if (next === undefined) return;
  for (const report of waiting.splice(0)) send(report);
}

/** An error as its name, message and stack; anything else as its value, or for an object only its kind. */
function describe(value: unknown): { readonly message: string; readonly stack?: string } {
  if (value instanceof Error) {
    return {
      message: `${value.name}: ${value.message}`,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    };
  }
  if (typeof value === "string") return { message: value };
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { message: String(value) };
  }
  // An object could hold the user's words: say only what kind of thing it was.
  return { message: `[${Object.prototype.toString.call(value).slice(8, -1)}]` };
}

/**
 * Forwards uncaught errors (a render that took the page down among them: React reports those to the window), unhandled
 * promise rejections and `console.error` calls. Called once, before the app renders; returns what undoes it.
 */
export function installPageErrorReporting(): () => void {
  const onError = (event: ErrorEvent): void => {
    const detail = event.error === undefined ? undefined : describe(event.error);
    reportPageError({
      kind: "error",
      message: event.message || detail?.message || "Uncaught error",
      ...(detail?.stack === undefined ? {} : { stack: detail.stack }),
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const detail = describe(event.reason);
    reportPageError({
      kind: "unhandledrejection",
      message: detail.message,
      ...(detail.stack === undefined ? {} : { stack: detail.stack }),
    });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  const original = console.error;
  let inside = false;
  console.error = (...args: unknown[]): void => {
    original.apply(console, args);
    if (inside) return;
    inside = true;
    try {
      const parts = args.map(describe);
      const stack = parts.find((part) => part.stack !== undefined)?.stack;
      reportPageError({
        kind: "console",
        message: parts.map((part) => part.message).join(" "),
        ...(stack === undefined ? {} : { stack }),
      });
    } finally {
      inside = false;
    }
  };

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    console.error = original;
  };
}
