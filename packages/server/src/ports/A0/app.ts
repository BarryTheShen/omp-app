import {
  AppFailure,
  AppHealth,
  AppPort,
  AppServerInfo,
  CapabilityMap,
  type ClientErrorReport,
  type DebugReport,
  UsableModels,
} from "@omp-app/contracts";
import { truncate } from "../../logging";
import { fileWatchMessage } from "../../modules/A1/fs/file-watch-registry";
import type { PortHandlerContext, PortRegistration } from "../../registry/ports";
import type { A0PortContext } from "./rpc-session";

/**
 * The health the page reads: the start-up checks, and the watched files the app cannot see changes for right now.
 * When the checks passed, a watch that cannot be opened makes the app degraded, not unavailable.
 */
export function currentHealth(context: Pick<A0PortContext, "health" | "fileWatch">): AppHealth {
  const base = context.health;
  if (base.status !== "ok" || context.fileWatch === undefined) return base;
  const watching = context.fileWatch.snapshot();
  if (watching.state === "ok") return base;
  return { status: "degraded", detail: fileWatchMessage(watching), code: "watch_limited" };
}

/** A page stuck in a loop must not fill the log: at most this many reports a minute are written. */
const CLIENT_ERRORS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

export function createAppPortRegistration(context: A0PortContext): PortRegistration {
  let windowStart = 0;
  let written = 0;
  let dropped = 0;
  return {
    port: AppPort,
    context,
    handlers: {
      serverInfo: (_args: unknown, _call: PortHandlerContext): AppServerInfo =>
        AppServerInfo.parse(context.serverInfo),
      capabilities: (_args: unknown, _call: PortHandlerContext) =>
        CapabilityMap.parse(context.capabilities),
      health: (_args: unknown, _call: PortHandlerContext): AppHealth =>
        AppHealth.parse(currentHealth(context)),
      usableModels: async (_args: unknown, _call: PortHandlerContext) =>
        UsableModels.parse({ models: [...((await context.usableModels?.()) ?? [])] }),
      reportClientError: (args: unknown, _call: PortHandlerContext): null => {
        const report = args as ClientErrorReport;
        const now = Date.now();
        if (now - windowStart >= MINUTE_MS) {
          if (dropped > 0) context.logger?.warn("client.error.suppressed", { count: dropped });
          windowStart = now;
          written = 0;
          dropped = 0;
        }
        if (written >= CLIENT_ERRORS_PER_MINUTE) {
          dropped += 1;
          return null;
        }
        written += 1;
        context.logger?.warn("client.error", {
          kind: report.kind,
          message: truncate(report.message, 500),
          stack: report.stack === undefined ? undefined : truncate(report.stack, 2_000),
          page: report.page,
        });
        return null;
      },
      debugReport: async (_args: unknown, _call: PortHandlerContext): Promise<DebugReport> => {
        if (context.debugReport === undefined) {
          throw new AppFailure({
            code: "unavailable",
            message: "The debug log is off in this run of the app.",
            retryable: false,
          });
        }
        return await context.debugReport();
      },
    },
  };
}
