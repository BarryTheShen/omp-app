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
    /** Where the app writes its debug log; absent when the app runs without one. */
    logFile: z.string().min(1).optional(),
  })
  .strict();
export type AppServerInfo = z.infer<typeof AppServerInfo>;

export const AppHealthStatus = z.enum(["ok", "degraded", "unhealthy"]);
export type AppHealthStatus = z.infer<typeof AppHealthStatus>;

export const AppHealth = z
  .object({
    status: AppHealthStatus,
    detail: z.string().optional(),
    /** Set when the page can say what to do: `no_model` (omp has no model to chat with), `watch_limited` (watched files cannot be watched right now). */
    code: z.enum(["no_model", "watch_limited"]).optional(),
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

/** An opt-in browser performance trace: names, durations and supported observer types only. */
export const ClientTraceReport = z
  .object({
    marks: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.number().finite().nonnegative()),
    gaps: z.array(z.number().finite().nonnegative()).max(200),
    supported: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(100),
  })
  .strict();
export type ClientTraceReport = z.infer<typeof ClientTraceReport>;

/** The debug log as one text file the browser can save and a person can attach to a bug report. */
export const DebugReport = z.object({ fileName: z.string().min(1), text: z.string() }).strict();
export type DebugReport = z.infer<typeof DebugReport>;

/** A model omp can use now (listed by `omp models --json`), named as omp names it: provider and model id. */
export const UsableModel = z
  .object({ provider: z.string().min(1), modelId: z.string().min(1), name: z.string() })
  .strict();
export type UsableModel = z.infer<typeof UsableModel>;

export const UsableModels = z.object({ models: z.array(UsableModel) }).strict();
export type UsableModels = z.infer<typeof UsableModels>;

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
    reportClientTrace: {
      args: ClientTraceReport,
      result: z.null(),
    },
    debugReport: {
      args: EmptyArgs,
      result: DebugReport,
    },
    usableModels: {
      args: EmptyArgs,
      result: UsableModels,
    },
  },
  events: {},
});

export type AppPort = typeof AppPort;
export type AppClient = PortClient<AppPort>;
export type AppHandlers<Context> = PortHandlers<AppPort, Context>;
