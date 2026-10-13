import { arch, cpus, homedir, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AppFailure,
  CapabilityMap,
  FolderPath,
  SessionFilePath,
  ThreadId,
} from "@omp-app/contracts";
import type { RpcSession } from "@omp-app/omp-rpc";
import serverPackage from "../package.json";
import {
  probeCapabilitiesPatiently,
  probeRanOutOfTime,
  probeTimedOutEntirely,
} from "../src/capabilities";
import {
  listUsableModels,
  OMP_PROBLEM,
  type OmpProbe,
  probeOmpPatiently,
  unhealthyAfterFailedChecks,
} from "../src/capabilities/omp-version";
import { openLaunchHistory } from "../src/launch-history";
import {
  buildDebugReport,
  createNullLogger,
  debugReportFileName,
  type Logger,
  listProcesses,
  startStatsSampler,
} from "../src/logging";
import { createProviderAccountStore } from "../src/modules/A1/accounts";
import { AttachmentStoreService } from "../src/modules/A1/attachments";
import { CheckpointStoreService } from "../src/modules/A1/checkpoints";
import {
  createConfigStoreWithOmpDefaults,
  ompEnvironmentValues,
  ompEnvironmentVariableNames,
} from "../src/modules/A1/config";
import { createDraftStore } from "../src/modules/A1/drafts";
import { createExtensionCatalog } from "../src/modules/A1/extensions";
import { searchWorkspaceFiles } from "../src/modules/A1/file-search";
import { FileWatchRegistry } from "../src/modules/A1/fs";
import { createOmpCommandGateway } from "../src/modules/A1/gateway";
import { readWorkspaceState } from "../src/modules/A1/git";
import { createGithubRefs } from "../src/modules/A1/github-refs";
import { readHostMetadata } from "../src/modules/A1/host";
import { createMemoryStore } from "../src/modules/A1/memory";
import { createSessionPinStore } from "../src/modules/A1/pins";
import { createPlanDocumentStore } from "../src/modules/A1/plans";
import { type A1PortContext, createA1PortRegistrations } from "../src/modules/A1/ports";
import { createRuleStore } from "../src/modules/A1/rules";
import { createSessionImportStore } from "../src/modules/A1/session-import";
import { createServerSessionFileStore } from "../src/modules/A1/sessions";
import { newestContinuableChat } from "../src/modules/A1/sessions/latest";
import { createUrlCatalog, type UrlCatalogResourceInput } from "../src/modules/A1/url-catalog";
import { createUsageLimitStore } from "../src/modules/A1/usage-limits";
import { type A0PortContext, createA0Runtime } from "../src/ports/A0";
import {
  findExternalOmp,
  logOmpProcess,
  OmpProcessRegistry,
  ompSessionOwnersDir,
  sessionLeaseProbe,
  spawnOmpProcess,
} from "../src/process";
import { createPortRegistry, type PortRegistry } from "../src/registry/ports";
import { EventReplayHub } from "../src/replay";
import { type AppServer, createAppServer } from "../src/server";

export interface CompositionServerOptions {
  readonly port?: number;
  readonly staticRoot?: string;
  readonly ompBin?: string;
  readonly ompArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly agentDir?: string;
  readonly appDataDir?: string;
  /** The version shown to the browser; the installed app passes its release version. */
  readonly serverVersion?: string;
  /** How long a chat's omp process lives after the last tab leaves it; the default is 2 minutes. */
  readonly idleCloseMs?: number;
  /** Test/embedding override for the process launch directory surfaced to the browser. */
  readonly cwd?: string;
  /** The debug log; without one nothing is written (tests and embeddings). */
  readonly logger?: Logger;
  /** How often the memory and process figures are logged; the default is 30 seconds. */
  readonly statsIntervalMs?: number;
  /** Test and embedding override for how watched files are opened and recorded; the default watches the real files. */
  readonly fileWatch?: FileWatchRegistry;
}

export interface CompositionServer extends AppServer {
  readonly processRegistry: OmpProcessRegistry;
  readonly health: OmpProbe["health"];
}

function environmentWithOverrides(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

/** Builds the complete app composition without starting a server until all registrations exist. */
export async function createCompositionServer(
  options: CompositionServerOptions = {},
): Promise<CompositionServer> {
  const baseEnv = environmentWithOverrides(options.env);
  const homeDir = resolve(options.homeDir ?? baseEnv.HOME ?? homedir());
  const agentDir = resolve(
    options.agentDir ?? baseEnv.PI_CODING_AGENT_DIR ?? join(homeDir, ".omp", "agent"),
  );
  const appDataDir = resolve(
    options.appDataDir ?? baseEnv.OMP_APP_DATA_DIR ?? join(agentDir, "app"),
  );
  const env: Record<string, string> = {
    ...baseEnv,
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    OMP_APP_DATA_DIR: appDataDir,
  };
  const launchFolder = resolve(options.cwd ?? process.cwd());
  const ompBinary = options.ompBin ?? env.OMP_BIN ?? "omp";
  const logger = options.logger ?? createNullLogger();
  const serverVersion = options.serverVersion ?? String(serverPackage.version);
  logger.info("start", {
    version: serverVersion,
    pid: process.pid,
    platform: platform(),
    os_release: release(),
    arch: arch(),
    bun: process.versions.bun,
    cpus: cpus().length,
    mem_total_mb: Math.round(totalmem() / 1_048_576),
    folder: launchFolder,
    home: homeDir,
    agent_dir: agentDir,
    app_data_dir: appDataDir,
    omp_bin: ompBinary,
    log_file: logger.path,
  });
  const probeStarted = performance.now();
  const probe = await probeOmpPatiently(ompBinary, env, launchFolder, {
    // A busy computer can need longer than a quiet one: it is asked once more, patiently.
    onRetry: (waitedMs) => logger.warn("omp.probe_retry", { waited_ms: waitedMs }),
  });
  logger.info("omp.probe", {
    status: probe.health.status,
    version: probe.version,
    detail: probe.health.detail,
    ms: Math.round(performance.now() - probeStarted),
  });
  let capabilities = CapabilityMap.parse({});
  let protocolVersion: 1 | 2 = 1;
  let health = probe.health;
  if (health.status === "ok") {
    const capabilityStarted = performance.now();
    try {
      const capabilityProbe = await probeCapabilitiesPatiently({
        cwd: FolderPath.parse(appDataDir),
        ompBin: ompBinary,
        env,
        onRetry: (waitedMs) => logger.warn("capabilities.probe_retry", { waited_ms: waitedMs }),
      });
      if (probeTimedOutEntirely(capabilityProbe)) {
        // Reporting "ok" with every omp feature unavailable would cripple the app until a restart
        // and say nothing about why.
        health = { status: "unhealthy", detail: OMP_PROBLEM.checksTimedOut };
        logger.error("capabilities.probe_failed", {
          message: "the capability probe ran out of time twice",
          ms: Math.round(performance.now() - capabilityStarted),
        });
      } else {
        capabilities = capabilityProbe.capabilities;
        protocolVersion = capabilityProbe.protocolVersion;
        const states = Object.values(capabilities).flatMap((capability) =>
          capability === undefined ? [] : [capability.state],
        );
        logger.info("capabilities.probe", {
          protocol: protocolVersion,
          available: states.filter((state) => state === "available").length,
          unavailable: states.filter((state) => state !== "available").length,
          partial_timeouts: probeRanOutOfTime(capabilityProbe),
          ms: Math.round(performance.now() - capabilityStarted),
        });
      }
    } catch (error) {
      health = await unhealthyAfterFailedChecks(ompBinary, env, launchFolder);
      logger.error("capabilities.probe_failed", {
        message: error instanceof Error ? error.message : String(error),
        ms: Math.round(performance.now() - capabilityStarted),
        no_model: health.code === "no_model",
      });
    }
  }
  const instanceId = crypto.randomUUID();
  const omp =
    health.status === "ok" && probe.version !== null
      ? { version: probe.version, protocolVersion }
      : null;
  const processRegistry = new OmpProcessRegistry({
    ...(options.idleCloseMs === undefined ? {} : { idleCloseMs: options.idleCloseMs }),
    createProcess: (processOptions) =>
      logOmpProcess(
        spawnOmpProcess({
          ...processOptions,
          ompBin: options.ompBin ?? processOptions.ompBin,
          args: [...(processOptions.args ?? []), ...(options.ompArgs ?? [])],
          env: { ...env, ...processOptions.env },
        }),
        logger,
      ),
  });
  const replay = new EventReplayHub();

  const resolveThread: A0PortContext["resolveThread"] = async (threadId, _signal) => {
    const file = await sessionFileStore.findSession(threadId);
    if (file === undefined) return undefined;
    return {
      threadId,
      folderPath: FolderPath.parse(file.cwd),
      sessionFile: SessionFilePath.parse(file.sessionFile),
    };
  };
  const latestThread: A0PortContext["latestThread"] = async (folderPath, _signal) => {
    const listed = await sessionFileStore.listSessions({ folder: folderPath });
    const newest = newestContinuableChat(listed.sessions);
    if (newest === undefined) return undefined;
    return {
      threadId: ThreadId.parse(newest.id),
      sessionFile: SessionFilePath.parse(newest.sessionFile),
    };
  };
  let launchToken = "";
  const fileWatch = options.fileWatch ?? new FileWatchRegistry();
  const a0Context: A0PortContext = {
    processRegistry,
    replay,
    resolveThread,
    latestThread,
    externalOmp: (threadId, sessionFile, hostPid) =>
      findExternalOmp({
        sessionId: threadId,
        sessionFile,
        ownersDir: ompSessionOwnersDir(env, homeDir),
        ownPid: hostPid,
      }),
    capabilities,
    usableModels: () => listUsableModels(ompBinary, env, launchFolder),
    serverInfo: {
      instanceId,
      serverVersion,
      launchFolder: FolderPath.parse(launchFolder),
      omp,
      ...(options.logger === undefined ? {} : { logFile: logger.path }),
    },
    health,
    fileWatch,
    logger,
    ...(options.logger === undefined
      ? {}
      : {
          debugReport: async () => {
            const now = new Date();
            return {
              fileName: debugReportFileName(now),
              text: buildDebugReport({
                directory: dirname(logger.path),
                version: serverVersion,
                now,
                omp: { path: ompBinary, version: probe.version },
                processes: await listProcesses(process.pid),
                secrets: [launchToken],
              }),
            };
          },
        }),
  };
  const a0Runtime = createA0Runtime(a0Context);
  const sessionFileStore = createServerSessionFileStore({
    sessionsRoot: join(agentDir, "sessions"),
    home: homeDir,
    chats: processRegistry,
    // Another omp holds a chat by its lease: the store refuses to delete such a chat, and lists it as held.
    leaseProbe: sessionLeaseProbe({ ownersDir: () => ompSessionOwnersDir(env, homeDir) }),
    views: a0Runtime.views,
  });
  const resolveSession = async (threadId: ThreadId): Promise<RpcSession> => {
    const session = a0Runtime.sessionFor(threadId);
    if (session === undefined) {
      throw new AppFailure({
        code: "not_found",
        message: `No open thread ${threadId}`,
        retryable: false,
      });
    }
    return session;
  };
  const configStore = await createConfigStoreWithOmpDefaults(
    {
      env,
      homeDir,
      agentDir,
      appDataDir,
      environmentValues: (projectDir) =>
        ompEnvironmentValues({ processEnv: env, homeDir, agentDir, projectDir }),
      watchRegistry: fileWatch,
      environmentVariables: ompEnvironmentVariableNames,
    },
    {
      binary: ompBinary,
      launchDirectory: launchFolder,
      pathEnvironment: env.PATH ?? "",
    },
  );
  const draftStore = createDraftStore({ env, homeDir, appDataDir, watchRegistry: fileWatch });
  const checkpointStore = new CheckpointStoreService({ appDataDir });
  const attachmentStore = new AttachmentStoreService({
    appDataDir,
    referencedAttachments: () => draftStore.referencedAttachments(),
  });
  const sessionImportStore = createSessionImportStore();
  await attachmentStore.cleanup({ orphanAgeMs: 24 * 60 * 60 * 1000 });
  const ompCommandGateway = createOmpCommandGateway({ resolveSession });
  const sessionPinStore = createSessionPinStore({
    env,
    homeDir,
    agentDir,
    watchRegistry: fileWatch,
  });
  const providerAccountStore = createProviderAccountStore({ env, homeDir, agentDir });
  const usageLimitStore = createUsageLimitStore({ env });
  const extensionCatalog = createExtensionCatalog({
    env,
    homeDir,
    agentDir,
    watchRegistry: fileWatch,
  });
  const memoryStore = createMemoryStore({ gateway: ompCommandGateway });
  const ruleStore = createRuleStore({ env, homeDir, agentDir, watchRegistry: fileWatch });
  const githubRefs = createGithubRefs({ env });
  const planDocumentStore = createPlanDocumentStore({ appDataDir });
  const urlCatalog = createUrlCatalog({
    loadResources: async (): Promise<readonly UrlCatalogResourceInput[]> => {
      const [rules, extensions] = await Promise.all([
        ruleStore.list({ scope: "global", folder: null }),
        extensionCatalog.list({ folder: null }),
      ]);
      return [
        ...rules.rules.map((rule) => ({
          scheme: "rule" as const,
          value: rule.id,
          label: rule.name,
          kind: "rule" as const,
          source: "omp" as const,
        })),
        ...extensions.extensions
          .filter(
            (extension) => extension.source === "skill" || extension.capabilities.includes("skill"),
          )
          .map((skill) => ({
            scheme: "skill" as const,
            value: skill.id,
            label: skill.name,
            ...(skill.description === undefined ? {} : { description: skill.description }),
            kind: "skill" as const,
            source: "omp" as const,
          })),
      ];
    },
    subscribeInvalidation: (invalidate) => {
      const unsubscribeRules = ruleStore.subscribe({ scope: "global", folder: null }, () =>
        invalidate(),
      );
      const unsubscribeExtensions = extensionCatalog.subscribe(null, () => invalidate());
      return () => {
        unsubscribeRules();
        unsubscribeExtensions();
      };
    },
  });
  const publish = replay.publish.bind(replay);
  const watchStreamActivity = replay.registerStreamActivity.bind(replay);
  const a1Context: A1PortContext = {
    sessionFileStore,
    processBusy: processRegistry,
    configStore,
    checkpointStore,
    draftStore,
    ompCommandGateway,
    sessionPinStore,
    providerAccountStore,
    usageLimitStore,
    extensionCatalog,
    memoryStore,
    ruleStore,
    sessionImportStore,
    attachmentStore,
    githubRefs,
    urlCatalog,
    planDocumentStore,
    readWorkspaceState,
    searchWorkspaceFiles,
    readHostMetadata,
    publish,
    watchStreamActivity,
    logger,
  };
  const registry: PortRegistry = createPortRegistry([
    ...a0Runtime.registrations,
    ...createA1PortRegistrations(a1Context),
  ]);
  const staticRoot = options.staticRoot ?? resolve(import.meta.dir, "../../..", "apps/web/dist");
  const launchHistory = openLaunchHistory(appDataDir, logger);
  const server = createAppServer({
    port: options.port,
    instanceId,
    serverVersion,
    omp,
    capabilities,
    replay,
    staticRoot,
    registry,
    logger,
    earlierLaunchTokens: launchHistory.earlier,
  });
  await launchHistory.remember(server.token);
  launchToken = server.token;
  logger.addSecret(server.token);
  logger.info("listening", { port: server.port, health: health.status, detail: health.detail });
  const stats = startStatsSampler({
    logger,
    processes: () => processRegistry.list(),
    ...(options.statsIntervalMs === undefined ? {} : { intervalMs: options.statsIntervalMs }),
  });
  return {
    ...server,
    processRegistry,
    health,
    async stop() {
      try {
        stats.stop();
        logger.info("stop");
        await server.stop();
      } finally {
        try {
          await processRegistry.closeAll();
        } finally {
          urlCatalog.dispose();
          extensionCatalog.dispose();
          ruleStore.dispose();
          attachmentStore.dispose();
          configStore.dispose();
          draftStore.dispose();
          sessionPinStore.dispose();
          memoryStore.dispose();
        }
      }
    },
  };
}

if (import.meta.main) {
  const server = await createCompositionServer();
  console.log(`${server.url}/#token=${encodeURIComponent(server.token)}`);
  const stop = () => void server.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
