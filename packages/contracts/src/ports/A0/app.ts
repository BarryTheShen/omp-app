/** The app-level server information, capabilities and health contract. */
import { z } from "zod";
import { CapabilityMap } from "../../core/capabilities";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";

export const AppServerInfo = z
  .object({
    /** Changes whenever the server process restarts; stream sequence numbers restart with it. */
    instanceId: z.string().min(1),
    serverVersion: z.string().min(1),
    /** Folder from which the app server was launched; the browser uses it as its initial workspace. */
    launchFolder: FolderPath,
    /** The omp release the server runs; null without omp. */
    omp: z.object({ version: z.string().min(1) }).nullable(),
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

/**
 * What a job that updates omp beside the app last said (`<app data>/omp-update.json`, which the job writes after every
 * night and the app only reads): when it last ran and what it came to, what it is doing now, a new omp ready for the app
 * to move to, and why updates stopped, when they did.
 */
export const OmpUpdateJob = z
  .object({
    lastNight: z.object({ at: z.string().min(1), result: z.string().min(1) }).strict(),
    /** What the job is doing now, while a run that may take long goes on (an Update now testing a new omp). */
    running: z.string().min(1).optional(),
    /** A new omp, released and checked: the job moves the app to it at the install hour. */
    pending: z.string().min(1).optional(),
    /** The pending omp came from Update now: it installs at the install hour even while automatic updates are off. */
    byRequest: z.literal(true).optional(),
    /** Why updates stopped until someone looks. */
    blocked: z.string().min(1).optional(),
  })
  .strict();
export type OmpUpdateJob = z.infer<typeof OmpUpdateJob>;

/** How often the job looks for a new omp, in nights (1 is every night). */
export const OMP_UPDATE_NIGHTS = { least: 1, most: 14, usual: 3 } as const;
/** The hour (local, 0-23) from which the job may install a new omp, for two hours; the latest lets it end by 23:00. */
export const OMP_UPDATE_HOURS = { least: 0, most: 21, usual: 3 } as const;

/** When the job looks for a new omp and when it installs one (`<app data>/omp-update-settings.json`). */
export const OmpUpdateSchedule = z
  .object({
    everyNights: z.number().int().min(OMP_UPDATE_NIGHTS.least).max(OMP_UPDATE_NIGHTS.most),
    installHour: z.number().int().min(OMP_UPDATE_HOURS.least).max(OMP_UPDATE_HOURS.most),
  })
  .strict();
export type OmpUpdateSchedule = z.infer<typeof OmpUpdateSchedule>;

/**
 * Settings → App → omp: whether automatic omp updates are on and when they run (`<app data>/omp-update-settings.json`,
 * which only the app writes), an Update now that waits for the job to take it (`<app data>/omp-update-request.json`),
 * and the job's last word; `job` is null where no such job has run.
 */
export const OmpUpdates = z
  .object({
    enabled: z.boolean(),
    schedule: OmpUpdateSchedule,
    request: z
      .object({ at: z.string().min(1) })
      .strict()
      .nullable(),
    job: OmpUpdateJob.nullable(),
  })
  .strict();
export type OmpUpdates = z.infer<typeof OmpUpdates>;

/** A change to the settings: any of them, at least one. */
export const SetOmpUpdatesArgs = z
  .object({
    enabled: z.boolean().optional(),
    everyNights: OmpUpdateSchedule.shape.everyNights.optional(),
    installHour: OmpUpdateSchedule.shape.installHour.optional(),
  })
  .strict()
  .refine((args) => Object.keys(args).length > 0, { message: "Name a setting to change." });
export type SetOmpUpdatesArgs = z.infer<typeof SetOmpUpdatesArgs>;

/** Where omp-app's releases are published: `<this>/download/v<version>/<file>`. */
export const APP_RELEASES = "https://github.com/BarryTheShen/omp-app/releases";

/** A release of omp-app as its version says it: three numbers (`0.3.1684`). */
export const AppVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "A version is three numbers, as 0.3.1684.");

/** Whether release `a` is newer than release `b` (three numbers each). */
export function isNewerRelease(a: string, b: string): boolean {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * Settings → App → omp-app's updates: the release the server runs and the newest one published, whether this server can
 * install one itself (and why not, with the command to run instead), an update under way or the last one that failed,
 * and the update that brought this release (its Go back).
 */
export const AppUpdates = z
  .object({
    installed: z.string().min(1),
    /** The newest release published; null until a check succeeded. */
    latest: z
      .object({ version: AppVersion, at: z.string().min(1) })
      .strict()
      .nullable(),
    /** When the newest release was last looked for; null before the first look. */
    checkedAt: z.string().min(1).nullable(),
    /** Why the last look failed, while it did. */
    checkProblem: z.string().min(1).optional(),
    install: z.discriminatedUnion("possible", [
      z.object({ possible: z.literal(true) }).strict(),
      z
        .object({
          possible: z.literal(false),
          reason: z.string().min(1),
          /** What to run on the server's computer instead, when there is such a command. */
          command: z.string().min(1).optional(),
        })
        .strict(),
    ]),
    /** An update this server started, while it goes on, or the last one that did not install. */
    job: z
      .object({
        version: AppVersion,
        step: z.enum(["downloading", "installing", "failed"]),
        at: z.string().min(1),
        detail: z.string().min(1).optional(),
      })
      .strict()
      .nullable(),
    /** The update that brought the release running now: Go back installs `from`. */
    last: z
      .object({ from: AppVersion, to: AppVersion, at: z.string().min(1) })
      .strict()
      .nullable(),
  })
  .strict();
export type AppUpdates = z.infer<typeof AppUpdates>;

export const AppUpdatesArgs = z
  .object({
    /** Look for a newer release now, not only when the last look is an hour old. */
    check: z.boolean().optional(),
  })
  .strict();
export type AppUpdatesArgs = z.infer<typeof AppUpdatesArgs>;

export const UpdateAppArgs = z.object({ version: AppVersion }).strict();
export type UpdateAppArgs = z.infer<typeof UpdateAppArgs>;

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
    ompUpdates: {
      args: EmptyArgs,
      result: OmpUpdates,
    },
    setOmpUpdates: {
      args: SetOmpUpdatesArgs,
      result: OmpUpdates,
    },
    /** Update now: asks the job beside the app to look for a new omp and test it now; it installs at the install hour. */
    requestOmpUpdate: {
      args: EmptyArgs,
      result: OmpUpdates,
    },
    appUpdates: {
      args: AppUpdatesArgs,
      result: AppUpdates,
    },
    /**
     * Installs a release of omp-app on the server's computer (a newer one, or the one before for Go back): downloads its
     * package, checks it against the release's checksums, installs it and restarts the server. Returns at once, the
     * download started; the server restarts when it is installed.
     */
    updateApp: {
      args: UpdateAppArgs,
      result: AppUpdates,
    },
  },
  events: {},
});

export type AppPort = typeof AppPort;
export type AppClient = PortClient<AppPort>;
export type AppHandlers<Context> = PortHandlers<AppPort, Context>;
