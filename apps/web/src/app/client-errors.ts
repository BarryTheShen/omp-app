import type { ClientErrorReport } from "@omp-app/contracts";

/**
 * Sends what goes wrong in the page to the app's debug log, so one report holds both halves. The
 * server cuts, scrubs and rate-limits what arrives; this side only keeps the page's own loop in
 * check, never includes the address's fragment or query (the launch token lives there), and never
 * reports a failure of reporting itself.
 */

export type ClientErrorSink = (report: ClientErrorReport) => Promise<unknown>;

/** Reports made before the connection exists wait here; the oldest are dropped past this. */
const MAX_WAITING = 20;
/** The same message again within this many ms is the same event repeating, not a new one. */
const REPEAT_WINDOW_MS = 1_000;
const MESSAGE_MAX = 2_000;
const STACK_MAX = 8_000;

let sink: ClientErrorSink | undefined;
const waiting: ClientErrorReport[] = [];
let lastMessage = "";
let lastAt = 0;

function pageAddress(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

function send(report: ClientErrorReport): void {
  if (sink === undefined) {
    waiting.push(report);
    if (waiting.length > MAX_WAITING) waiting.shift();
    return;
  }
  // A failed report is dropped: reporting it would report the reporter, forever.
  void sink(report).catch(() => undefined);
}

/** Hands one error to the debug log (or holds it until the connection can take it). */
export function reportClientError(report: Omit<ClientErrorReport, "page">): void {
  const now = Date.now();
  if (report.message === lastMessage && now - lastAt < REPEAT_WINDOW_MS) return;
  lastMessage = report.message;
  lastAt = now;
  send({
    ...report,
    message: report.message.slice(0, MESSAGE_MAX),
    ...(report.stack === undefined ? {} : { stack: report.stack.slice(0, STACK_MAX) }),
    page: pageAddress(),
  });
}

/** Where reports go once the app is connected; `undefined` when the connection ends. */
export function setClientErrorSink(next: ClientErrorSink | undefined): void {
  sink = next;
  if (next === undefined) return;
  for (const report of waiting.splice(0)) send(report);
}

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
 * Forwards uncaught errors, unhandled promise rejections and `console.error` calls. Returns a
 * function that undoes it. Safe to call once at start-up.
 */
export function installClientErrorReporting(): () => void {
  const onError = (event: ErrorEvent): void => {
    const detail = event.error === undefined ? undefined : describe(event.error);
    reportClientError({
      kind: "error",
      message: event.message || detail?.message || "Uncaught error",
      ...(detail?.stack === undefined ? {} : { stack: detail.stack }),
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const detail = describe(event.reason);
    reportClientError({
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
      reportClientError({
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
