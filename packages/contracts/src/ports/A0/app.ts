/** The app-level server information, capabilities and health contract. */
import { z } from "zod";
import { CapabilityMap } from "../../core/capabilities";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";
import { OMP_PROTOCOL_VERSIONS } from "../../core/omp";

export const AppServerInfo = z
  .object({
    /** Changes whenever the server process restarts; stream sequence numbers restart with it. */
    instanceId: z.string().min(1),
    serverVersion: z.string().min(1),
    /** Folder from which the app server was launched; the browser uses it as its initial workspace. */
    launchFolder: FolderPath,
    omp: z
      .object({
        version: z.string().min(1),
        protocolVersion: z.union(OMP_PROTOCOL_VERSIONS.map((version) => z.literal(version))),
      })
      .nullable(),
  })
  .strict();
export type AppServerInfo = z.infer<typeof AppServerInfo>;

export const AppHealthStatus = z.enum(["ok", "degraded", "unhealthy"]);
export type AppHealthStatus = z.infer<typeof AppHealthStatus>;

export const AppHealth = z
  .object({
    status: AppHealthStatus,
    detail: z.string().optional(),
  })
  .strict();
export type AppHealth = z.infer<typeof AppHealth>;

const EmptyArgs = z.object({}).strict();

/** An error the browser reports so it lands in the app's debug log (never prompts or file contents). */
export const ClientErrorReport = z
  .object({
    /** Where it came from: an uncaught error, an unhandled rejection, a console error, or a failed render. */
    kind: z.enum(["error", "unhandledrejection", "console", "render"]),
    message: z.string().max(2_000),
    stack: z.string().max(8_000).optional(),
    /** The page address without its fragment or query (the launch link's token lives there). */
    page: z.string().max(300).optional(),
  })
  .strict();
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;

/** The debug log as one text file the browser can save and a person can attach to a bug report. */
export const DebugReport = z.object({ fileName: z.string().min(1), text: z.string() }).strict();
export type DebugReport = z.infer<typeof DebugReport>;

export const AppPort = definePort({
  name: "A0.app",
  methods: {
    serverInfo: {
      args: EmptyArgs,
      result: AppServerInfo,
    },
    capabilities: {
      args: EmptyArgs,
      result: CapabilityMap,
    },
    health: {
      args: EmptyArgs,
      result: AppHealth,
    },
    reportClientError: {
      args: ClientErrorReport,
      result: z.null(),
    },
    debugReport: {
      args: EmptyArgs,
      result: DebugReport,
    },
  },
  events: {},
});

export type AppPort = typeof AppPort;
export type AppClient = PortClient<AppPort>;
export type AppHandlers<Context> = PortHandlers<AppPort, Context>;
