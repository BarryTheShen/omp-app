import { type AppError, AppFailure, type CommandRunResult, ThreadId } from "@omp-app/contracts";
import { createRoot } from "react-dom/client";
import { OverlayHost } from "@/overlay/overlay-host";
import type {
  DiagnosticCommandPort,
  DiagnosticCommandRequest,
  DiagnosticCommandResult,
} from "../contract";
import { SecurityPanel } from "../security/security-panel";
import { SecurityReportPanel } from "../security/security-panel-container";
import realTexts from "./fixtures/real-texts.json";
import { diagnosticResultOf } from "./port";
import { DiagnosticReportPanel } from "./report-panel";
import { ReportsPanel } from "./reports-panel";
import type { ReportSnapshot } from "./runner";

/** One completed run whose only output is omp's text, as the gateway reports it. */
function runOf(text: string): CommandRunResult {
  return {
    command: "/context",
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: [{ text }],
    sessionUpdates: [],
    configUpdates: [],
  };
}

/** A ready report built by the same mapping the app uses, so colour codes are removed as they are in the app. */
function readyReport(title: string, text: string): ReportSnapshot {
  const result = diagnosticResultOf({ name: "jobs" }, runOf(text));
  return {
    status: "ready",
    title,
    lines: result.lines,
    truncated: result.truncated,
    promptSettled: result.promptSettled,
    aborted: result.status === "aborted",
    error: null,
  };
}

const READY = readyReport("Context report", realTexts.context);

const unavailableReason =
  "Security scans need omp's command gateway, which this connection does not have.";
const failure: AppError = {
  code: "omp_error",
  message: "omp could not finish this report.",
  retryable: true,
};

const REPORT_STATES: Record<string, ReportSnapshot | undefined> = {
  ready: READY,
  usage: readyReport("Usage report", realTexts.usage),
  loading: {
    status: "loading",
    title: "Jobs report",
    lines: [],
    truncated: false,
    promptSettled: false,
    aborted: false,
    error: null,
  },
  empty: {
    status: "empty",
    title: "Jobs report",
    lines: [],
    truncated: false,
    promptSettled: true,
    aborted: false,
    error: null,
  },
  failed: {
    status: "error",
    title: "Jobs report",
    lines: [],
    truncated: false,
    promptSettled: true,
    aborted: false,
    message: "omp could not finish this report.",
    error: failure,
  },
  unavailable: {
    status: "unavailable",
    title: "Security scans",
    lines: [],
    truncated: false,
    promptSettled: true,
    aborted: false,
    message: unavailableReason,
    error: { code: "unavailable", message: unavailableReason, retryable: false },
  },
};

const THREAD = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");

/** One run's result as the app maps it. With no text, omp printed nothing, as it does for validate. */
function resultFor(request: DiagnosticCommandRequest, text?: string): DiagnosticCommandResult {
  const run: CommandRunResult = { ...runOf(""), outputs: text === undefined ? [] : [{ text }] };
  return diagnosticResultOf(request, run);
}

/**
 * A stand-in for omp's command gateway for the live panels. The first report fails, so the panel
 * offers "Try again"; after that omp's words come back. validate prints nothing, because omp
 * answers it in the chat.
 */
function livePort(): DiagnosticCommandPort {
  let failedOnce = false;
  return {
    async run(_thread, request) {
      if (request.name === "security" && request.args?.startsWith("validate")) {
        return resultFor(request);
      }
      if (!failedOnce) {
        failedOnce = true;
        throw new AppFailure({
          code: "omp_error",
          message: "omp stopped responding.",
          retryable: true,
        });
      }
      return resultFor(request, realTexts.context);
    },
    async cancel() {
      throw new AppFailure({
        code: "unavailable",
        message: "This playground cannot stop a report.",
        retryable: false,
      });
    },
  };
}

const reportsPort = livePort();
const securityPort = livePort();

function Playground() {
  const state = new URLSearchParams(window.location.search).get("state") ?? "ready";
  if (state === "reports-live") {
    return (
      <OverlayHost>
        <div className="mx-auto h-[calc(100vh-2rem)] max-w-3xl p-4">
          <ReportsPanel onOpenChange={() => undefined} open port={reportsPort} threadId={THREAD} />
        </div>
      </OverlayHost>
    );
  }
  if (state === "security-live") {
    return (
      <OverlayHost>
        <div className="mx-auto h-[calc(100vh-2rem)] max-w-3xl p-4">
          <SecurityReportPanel
            onOpenChange={() => undefined}
            open
            port={securityPort}
            threadId={THREAD}
          />
        </div>
      </OverlayHost>
    );
  }
  if (state === "security") {
    return (
      <div className="mx-auto h-[calc(100vh-2rem)] max-w-3xl p-4">
        <SecurityPanel
          onOpenChange={() => undefined}
          onRun={() => undefined}
          open
          snapshot={READY}
        />
      </div>
    );
  }
  return (
    <div className="mx-auto h-[calc(100vh-2rem)] max-w-3xl p-4">
      <DiagnosticReportPanel
        fallbackTitle="Reports"
        onOpenChange={() => undefined}
        onRetry={() => undefined}
        open
        snapshot={REPORT_STATES[state] ?? READY}
      />
    </div>
  );
}

// The theme comes from the page's own address and is applied before the first render.
const theme = new URLSearchParams(window.location.search).get("theme");
document.documentElement.classList.toggle("dark", theme === "dark");

const root = document.getElementById("d6-3-reports-playground-root");
if (root === null) throw new Error("The reports playground page has no root element.");
createRoot(root).render(<Playground />);
