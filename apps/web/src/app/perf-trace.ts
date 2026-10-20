import type { ClientTraceReport } from "@omp-app/contracts";

const ENABLED_KEY = "omp-app.perf";
const QUIET_MS = 15_000;
const GAP_LIMIT = 200;
export type PerfMarkName =
  | "click"
  | "first_feedback"
  | "window_applied"
  | "newest_20_painted"
  | "rpc_open_returned"
  | "composer_typable"
  | "send_accepted"
  | "send_delivered"
  | "leaf_swap"
  | "data_app_root_visible"
  | "list_rows_visible";
type TraceReport = (trace: ClientTraceReport) => void;

interface ActiveTrace {
  readonly marks: Partial<Record<PerfMarkName, number>>;
  readonly gaps: number[];
  readonly supported: string[];
  report: TraceReport;
  flushTimer: number | undefined;
  frame: number | undefined;
  lastFrame: number;
}

let active: ActiveTrace | undefined;
let traceEnabled = false;
let traceReport: TraceReport | undefined;
const startupMarks: Partial<Record<PerfMarkName, number>> = {};
let supported: string[] = [];

export function perfTraceEnabled(): boolean {
  return (
    (typeof window !== "undefined" && window.localStorage.getItem(ENABLED_KEY) === "1") ||
    import.meta.env.VITE_OMP_APP_PERF === "1"
  );
}

function finish(trace: ActiveTrace): void {
  if (active !== trace) return;
  active = undefined;
  if (trace.flushTimer !== undefined) window.clearTimeout(trace.flushTimer);
  if (trace.frame !== undefined) cancelAnimationFrame(trace.frame);
  trace.report({
    marks: Object.fromEntries(
      Object.entries(trace.marks).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    ),
    gaps: trace.gaps,
    supported: trace.supported,
  });
}

export function perfMark(name: PerfMarkName): void {
  if (!traceEnabled) return;
  const trace = active;
  if (trace === undefined) {
    if (startupMarks[name] === undefined) startupMarks[name] = performance.now();
    return;
  }
  if (trace.marks[name] !== undefined) return;
  trace.marks[name] = performance.now();
  performance.mark(name);
  if (trace.flushTimer !== undefined) window.clearTimeout(trace.flushTimer);
  trace.flushTimer = window.setTimeout(() => finish(trace), QUIET_MS);
}

export function perfTraceStart(report = traceReport): void {
  if (!traceEnabled || report === undefined) return;
  if (active !== undefined) finish(active);
  const marks: Partial<Record<PerfMarkName, number>> = { ...startupMarks };
  for (const name of Object.keys(startupMarks) as PerfMarkName[]) delete startupMarks[name];
  const trace: ActiveTrace = {
    marks,
    gaps: [],
    supported,
    report,
    flushTimer: undefined,
    frame: undefined,
    lastFrame: performance.now(),
  };
  active = trace;
  requestAnimationFrame(() => {
    if (document.querySelector('[data-app-root="true"]') !== null)
      perfMark("data_app_root_visible");
    if (document.querySelector('[aria-label="Sessions"]') !== null) perfMark("list_rows_visible");
  });
  perfMark("click");
  const sample = (now: number): void => {
    if (active !== trace) return;
    const gap = now - trace.lastFrame;
    if (gap > 50 && trace.gaps.length < GAP_LIMIT) trace.gaps.push(Math.round(gap * 10) / 10);
    trace.lastFrame = now;
    if (document.querySelector('[data-slot="r1-session-row"]') !== null)
      perfMark("list_rows_visible");
    if (
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message input"]:not([disabled])',
      )
    )
      perfMark("composer_typable");
    trace.frame = requestAnimationFrame(sample);
  };
  trace.frame = requestAnimationFrame(sample);
  trace.flushTimer = window.setTimeout(() => finish(trace), QUIET_MS);
}

/** Installs the opt-in recorder. Disabled runs allocate no observer, listener, or timer. */
export function installPerfTrace(enabled: boolean, report: TraceReport): () => void {
  traceEnabled = enabled;
  traceReport = enabled ? report : undefined;
  if (!enabled) return () => undefined;
  supported =
    typeof PerformanceObserver === "undefined"
      ? []
      : [...PerformanceObserver.supportedEntryTypes].filter((name) =>
          /^[a-z][a-z0-9-]{0,63}$/u.test(name),
        );
  if (document.querySelector('[data-app-root="true"]') !== null)
    startupMarks.data_app_root_visible = performance.now();
  if (document.querySelector('[data-slot="r1-session-row"]') !== null)
    startupMarks.list_rows_visible = performance.now();
  return () => {
    if (active !== undefined) finish(active);
    traceEnabled = false;
    traceReport = undefined;
  };
}
