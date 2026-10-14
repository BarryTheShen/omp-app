import { type AppError, AppFailure, type ThreadId } from "@omp-app/contracts";
import type {
  DiagnosticCommandPort,
  DiagnosticCommandRequest,
  DiagnosticCommandResult,
  RedactedReportLine,
} from "../contract";

export type ReportStatus = "idle" | "loading" | "ready" | "empty" | "error" | "unavailable";

export interface ReportSnapshot {
  readonly status: ReportStatus;
  readonly title: string;
  /** omp's words, one entry per line, already redacted by D6.1. */
  readonly lines: readonly RedactedReportLine[];
  readonly truncated: boolean;
  /** False while omp has not finished the prompt; the report still shows what omp printed. */
  readonly promptSettled: boolean;
  /** omp stopped the command before it finished; the lines are what it printed first. */
  readonly aborted: boolean;
  /** The reason for an error, cancelled or unavailable state, in plain words. */
  readonly message?: string;
  /** What an empty report says instead of the default, when the run was given a sentence for it. */
  readonly note?: string;
  readonly error: AppError | null;
}

/** Settings for one run. `emptyNote` is shown if omp prints no text for it. */
export interface RunOptions {
  readonly emptyNote?: string;
}

export const IDLE_REPORT: ReportSnapshot = {
  status: "idle",
  title: "",
  lines: [],
  truncated: false,
  promptSettled: true,
  aborted: false,
  error: null,
};

const ERROR_FALLBACK = "omp could not finish this report.";
const CANCELLED = "The command was cancelled before it finished.";

function reportFromResult(
  result: DiagnosticCommandResult,
  title: string,
  emptyNote: string | undefined,
): ReportSnapshot {
  const base = {
    title,
    lines: result.lines,
    truncated: result.truncated,
    promptSettled: result.promptSettled,
    error: null,
  };
  if (result.status === "error") {
    return { ...base, status: "error", aborted: false, message: ERROR_FALLBACK };
  }
  if (result.status === "aborted") {
    return {
      ...base,
      status: result.lines.length === 0 ? "error" : "ready",
      aborted: true,
      message: CANCELLED,
    };
  }
  if (result.lines.length === 0) {
    return { ...base, status: "empty", aborted: false, note: emptyNote };
  }
  return { ...base, status: "ready", aborted: false };
}

function reportFromError(error: unknown, title: string): ReportSnapshot {
  const appError = error instanceof AppFailure ? error.appError : null;
  return {
    status: appError?.code === "unavailable" ? "unavailable" : "error",
    title,
    lines: [],
    truncated: false,
    promptSettled: true,
    aborted: false,
    error: appError,
    message: appError?.message ?? ERROR_FALLBACK,
  };
}

/**
 * Runs one diagnostic report at a time through the port. A newer run, or closing the panel, stops
 * waiting for the run in flight and its late answer is dropped, so a stale report never replaces
 * the one on screen. omp is not told to stop: it finishes the command it was given. Framework-free:
 * the React hook subscribes to it.
 */
export class DiagnosticReportRunner {
  private snapshot: ReportSnapshot = IDLE_REPORT;
  private inFlight: AbortController | undefined;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private readonly port: DiagnosticCommandPort;
  private readonly threadId: ThreadId;

  public constructor(port: DiagnosticCommandPort, threadId: ThreadId) {
    this.port = port;
    this.threadId = threadId;
  }

  public getSnapshot = (): ReportSnapshot => this.snapshot;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public async run(
    request: DiagnosticCommandRequest,
    title: string,
    options: RunOptions = {},
  ): Promise<void> {
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const generation = ++this.generation;
    this.set({ ...IDLE_REPORT, status: "loading", title });
    try {
      const result = await this.port.run(this.threadId, request, { signal: controller.signal });
      if (generation !== this.generation) return;
      this.set(reportFromResult(result, title, options.emptyNote));
    } catch (error) {
      if (generation !== this.generation) return;
      this.set(reportFromError(error, title));
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }

  /** Stops waiting for the run in flight and returns the panel to its idle state. */
  public close(): void {
    this.generation += 1;
    this.inFlight?.abort();
    this.inFlight = undefined;
    this.set(IDLE_REPORT);
  }

  public dispose(): void {
    this.close();
    this.listeners.clear();
  }

  private set(next: ReportSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
