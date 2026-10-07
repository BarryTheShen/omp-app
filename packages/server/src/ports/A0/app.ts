import {
  AppFailure,
  AppHealth,
  AppPort,
  AppServerInfo,
  CapabilityMap,
  type ClientErrorReport,
  type DebugReport,
} from "@omp-app/contracts";
import { truncate } from "../../logging";
import type { PortHandlerContext, PortRegistration } from "../../registry/ports";
import type { A0PortContext } from "./rpc-session";

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
        AppHealth.parse(context.health),
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
