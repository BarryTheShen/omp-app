import type { ThreadId } from "@omp-app/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { DiagnosticCommandPort } from "../contract";
import { DiagnosticReportRunner, type ReportSnapshot } from "./runner";

/**
 * The report runner for one thread and port, read as React state. The runner is rebuilt only when
 * the port or the thread really changes, and it is disposed when they do.
 */
export function useDiagnosticReport(
  port: DiagnosticCommandPort,
  threadId: ThreadId,
): { readonly snapshot: ReportSnapshot; readonly runner: DiagnosticReportRunner } {
  const runner = useMemo(() => new DiagnosticReportRunner(port, threadId), [port, threadId]);
  useEffect(() => () => runner.dispose(), [runner]);
  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  return { snapshot, runner };
}
