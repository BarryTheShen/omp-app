import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { arch, cpus, homedir, hostname, platform, release, totalmem, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { VERSION as OMP_VERSION } from "@oh-my-pi/pi-utils/dirs";
import {
  AppFailure,
  CapabilityMap,
  FolderPath,
  SessionFilePath,
  ThreadId,
} from "@omp-app/contracts";
import { CHAT_HOST_FEATURES, CHAT_HOST_PROTOCOL_VERSION } from "@omp-app/contracts/chat-host";
import serverPackage from "../package.json";
import { EDGE_RELAY_PORT, EdgeRelay } from "../src/browser/edge-relay";
import { findChrome, SERVER_BROWSER_PORT, ServerBrowser } from "../src/browser/server-browser";
import {
  type CapabilityProbeResult,
  capabilityProbeResultFromRaw,
  type PatientProbeOptions,
  probeCapabilitiesPatiently,
  probeGithubRefs,
  probeTimedOut,
} from "../src/capabilities";
import {
  listUsableModels,
  OMP_PROBLEM,
  type OmpProbe,
  probeOmpPatiently,
  unhealthyAfterFailedChecks,
} from "../src/capabilities/omp-version";
import { openDevicePairing } from "../src/devices";
import { FRAME_ANCESTORS_ENV, parseFrameAncestors } from "../src/frame-ancestors";
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
import { BackgroundJobStopStoreService } from "../src/modules/A1/background-jobs";
import { CheckpointStoreService } from "../src/modules/A1/checkpoints";
import {
  createConfigStoreWithOmpDefaults,
  type OmpDefaultsProbeResult,
  ompEnvironmentValues,
  ompEnvironmentVariableNames,
  probeOmpDefaults,
} from "../src/modules/A1/config";
import { createDraftStore } from "../src/modules/A1/drafts";
import { createExtensionCatalog } from "../src/modules/A1/extensions";
import { searchWorkspaceFiles } from "../src/modules/A1/file-search";
import { FileWatchRegistry } from "../src/modules/A1/fs";
import { type CommandSession, createOmpCommandGateway } from "../src/modules/A1/gateway";
import { readWorkspaceState } from "../src/modules/A1/git";
import { createGithubRefs } from "../src/modules/A1/github-refs";
import { readHostMetadata } from "../src/modules/A1/host";
import { createMemoryStore } from "../src/modules/A1/memory";
import { ModelPreferenceStoreService } from "../src/modules/A1/model-preferences";
import { createPasteFileStore } from "../src/modules/A1/paste-files";
import { createSessionPinStore } from "../src/modules/A1/pins";
import { createPlanDocumentStore } from "../src/modules/A1/plans";
import { type A1PortContext, createA1PortRegistrations } from "../src/modules/A1/ports";
import { createRuleStore } from "../src/modules/A1/rules";
import { createSessionImportStore } from "../src/modules/A1/session-import";
import { createServerSessionFileStore } from "../src/modules/A1/sessions";
import { newestContinuableChat } from "../src/modules/A1/sessions/latest";
import { sessionDisplayTitle } from "../src/modules/A1/sessions/title-card";
import { createUrlCatalog, type UrlCatalogResourceInput } from "../src/modules/A1/url-catalog";
import { createUsageLimitStore, UsageReadings } from "../src/modules/A1/usage-limits";
import { createWorkspaceFiles } from "../src/modules/A1/workspace-files";
import { chatHostCommand, ompCommand } from "../src/omp-host/chat-command";
import {
  type A0PortContext,
  createA0Runtime,
  createBrowserRuntime,
  createDevicesPortRegistration,
  createRunningChatsRuntime,
  createSharesRuntime,
  OmpStats,
} from "../src/ports/A0";
import {
  type ProbeCacheHit,
  type ProbeCacheIdentity,
  probeCacheIdentity,
  readProbeCache,
  writeProbeCache,
} from "../src/probe-cache";
import {
  adoptRunningHosts,
  findExternalOmp,
  hostsFolder,
  logOmpProcess,
  OmpProcessRegistry,
  ompSessionOwnersDir,
  restartsWhenSettled,
  sessionLeaseProbe,
  spawnDetachedOmpProcess,
  spawnOmpProcess,
  systemdUserScopes,
} from "../src/process";
import { createPortRegistry, type PortRegistry } from "../src/registry/ports";
import { parseRemoteOrigin, REMOTE_ORIGIN_ENV } from "../src/remote-origin";
import { EventReplayHub } from "../src/replay";
import { type AppServer, createAppServer } from "../src/server";

export interface CompositionServerOptions {
  readonly port?: number;
  readonly staticRoot?: string;
  /** The new UI's built folder, served at the root (default: `apps/ui/dist` of this checkout). */
  readonly uiRoot?: string;
  /**
   * Test seam: a program that stands in for omp's command line in omp's own commands (`--version`, `models`, `usage`,
   * `config`; a wrapper script or a missing program in some e2e specs). Without it they run `ompCommand()`, the same
   * command line as the chats.
   */
  readonly ompBin?: string;
  readonly ompArgs?: readonly string[];
  /**
   * The chat host compiled to one program (`scripts/build-chat-host.ts`: the app's entry with omp's command line, built
   * from the pinned package), which runs every chat. Default: `OMP_APP_CHAT_HOST_BIN`; without either, the chat host's
   * entry from source (`src/chat-host/main.ts`) on the Bun running this server.
   */
  readonly chatHostBinary?: string;
  /** Test seam: a program every chat runs through, given the chat's whole command as its arguments (`chatHostCommand()`). */
  readonly chatWrapper?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly agentDir?: string;
  readonly appDataDir?: string;
  /**
   * Keep a new chat ready in the folders new chats were opened in last (#2760). The installed app turns it on; tests leave
   * it off unless `OMP_APP_NEW_CHATS_READY=1` (a spare is one more omp per folder).
   */
  readonly newChatsReady?: boolean;
  /** The version shown to the browser; the installed app passes its release version. */
  readonly serverVersion?: string;
  /**
   * The launch token, the secret in the app's link. The installed command passes the one it keeps across restarts
   * (`src/launch-token.ts`); without one, every start makes a new one.
   */
  readonly token?: string;
  /** How long a chat's omp process lives after the last tab leaves it; the default is 2 minutes. */
  readonly idleCloseMs?: number;
  /** Test/embedding override for the process launch directory surfaced to the browser. */
  readonly cwd?: string;
  /** The debug log; without one nothing is written (tests and embeddings). */
  readonly logger?: Logger;
  /** How often the memory and process figures are logged; the default is 30 seconds. */
  readonly statsIntervalMs?: number;
  /** Test seam for short capability-probe deadlines; normal launches use the production defaults. */
  readonly capabilityProbeSettings?: Pick<
    PatientProbeOptions,
    "timeoutMs" | "deadlineMs" | "patient"
  >;
  /** Test and embedding override for how watched files are opened and recorded; the default watches the real files. */
  readonly fileWatch?: FileWatchRegistry;
  /** Test seam for the lease probe the chat session port's `open` asks before it starts omp for a chat; the default reads omp's lease sockets. */
  readonly leaseProbe?: (sessionId: string) => Promise<"active" | "inactive" | "unknown">;
}

export interface CompositionServer extends AppServer {
  readonly processRegistry: OmpProcessRegistry;
  readonly health: OmpProbe["health"];
  /** The Tailscale address the app can also be opened at (`OMP_APP_REMOTE_ORIGIN`), when one is set. */
  readonly remoteUrl: string | undefined;
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
  const logger = options.logger ?? createNullLogger();
  const serverVersion = options.serverVersion ?? String(serverPackage.version);
  // A bad value stops the start before anything runs: the app must never listen for an address it cannot check.
  const remote = parseRemoteOrigin(env[REMOTE_ORIGIN_ENV]);
  // The pages that may frame the lite view (#2843); a bad one stops the start the same way.
  const frameAncestors = parseFrameAncestors(env[FRAME_ANCESTORS_ENV]);
  // omp's own command line, built by the app (#2586): it answers omp's commands, runs every chat on the chat host's own
  // protocol (SDK plan H5.4a) and the check of what a chat answers (H5.6a). Never an omp installed on the computer.
  const chatHostBinary = options.chatHostBinary ?? env.OMP_APP_CHAT_HOST_BIN;
  const chats = chatHostCommand({ binary: chatHostBinary, wrapper: options.chatWrapper });
  // D2: chats in hosts that outlive the server, when `OMP_APP_DETACHED_HOSTS=1` (off by default). Each app data folder
  // (each server, real or a test's) has its own folder of host sockets.
  const detachedHosts = env.OMP_APP_DETACHED_HOSTS === "1";
  const hostsDir = hostsFolder(appDataDir, env);
  const newChatsReady = options.newChatsReady ?? env.OMP_APP_NEW_CHATS_READY === "1";
  const systemdScope = detachedHosts && systemdUserScopes(env);
  const ompCmd =
    options.ompBin === undefined ? ompCommand({ binary: chatHostBinary }) : [options.ompBin];
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
    omp_bin: ompCmd.join(" "),
    log_file: logger.path,
  });
  // The omp release that versions before the chat host downloaded into the app's data folder (about 257 MB) is never run
  // again, so it goes.
  const oldOmpDownload = join(appDataDir, "omp");
  if (existsSync(oldOmpDownload)) {
    try {
      await rm(oldOmpDownload, { recursive: true, force: true });
      logger.info("omp.old_download_removed", { path: oldOmpDownload });
    } catch (error) {
      logger.warn("omp.old_download_kept", {
        path: oldOmpDownload,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const probeStarted = performance.now();
  const probe: OmpProbe = await probeOmpPatiently(ompCmd, env, launchFolder, {
    // A busy computer can need longer than a quiet one: it is asked once more, patiently.
    onRetry: (waitedMs) => logger.warn("omp.probe_retry", { waited_ms: waitedMs }),
  });
  const ompProbeMs = Math.round(performance.now() - probeStarted);
  const defaultsProbe = {
    command: ompCmd,
    launchDirectory: launchFolder,
    pathEnvironment: env.PATH ?? "",
  };
  let cacheStatus: "hit" | "miss" = "miss";
  let cacheIdentity: ProbeCacheIdentity | undefined;
  let cacheHit: ProbeCacheHit | undefined;
  let defaultsResult: OmpDefaultsProbeResult;
  let capabilityResult: CapabilityProbeResult | undefined;
  let health = probe.health;
  if (probe.health.status === "ok" && probe.version !== null) {
    try {
      cacheIdentity = await probeCacheIdentity(ompCmd, probe.version, env);
      cacheHit = await readProbeCache(appDataDir, cacheIdentity);
    } catch {
      cacheIdentity = undefined;
      cacheHit = undefined;
    }
    if (cacheHit !== undefined) {
      cacheStatus = "hit";
      defaultsResult = cacheHit.defaults;
      logger.info("omp.defaults_probe", { ms: 0, cache: cacheStatus });
      const capabilityStarted = performance.now();
      const githubAvailable = await probeGithubRefs({ env });
      capabilityResult = capabilityProbeResultFromRaw(cacheHit.raw, { githubAvailable });
      logger.info("capabilities.probe", {
        available: Object.values(capabilityResult.capabilities).filter(
          (capability) => capability?.state === "available",
        ).length,
        unavailable: Object.values(capabilityResult.capabilities).filter(
          (capability) => capability?.state !== "available",
        ).length,
        timed_out: false,
        ms: Math.round(performance.now() - capabilityStarted),
        cache: cacheStatus,
      });
    } else {
      const capabilityStarted = performance.now();
      const capabilityPromise = probeCapabilitiesPatiently({
        cwd: FolderPath.parse(appDataDir),
        chatCommand: chats,
        env,
        ...options.capabilityProbeSettings,
        onRetry: (waitedMs) => logger.warn("capabilities.probe_retry", { waited_ms: waitedMs }),
      });
      const defaultsStarted = performance.now();
      const defaultsPromise = probeOmpDefaults(defaultsProbe);
      try {
        capabilityResult = await capabilityPromise;
      } catch (error) {
        health = await unhealthyAfterFailedChecks(ompCmd, env, launchFolder);
        logger.error("capabilities.probe_failed", {
          message: error instanceof Error ? error.message : String(error),
          ms: Math.round(performance.now() - capabilityStarted),
          no_model: health.code === "no_model",
          cache: cacheStatus,
        });
      }
      defaultsResult = await defaultsPromise;
      logger.info("omp.defaults_probe", {
        ms: Math.round(performance.now() - defaultsStarted),
        cache: cacheStatus,
      });
      if (capabilityResult !== undefined) {
        logger.info("capabilities.probe", {
          available: Object.values(capabilityResult.capabilities).filter(
            (capability) => capability?.state === "available",
          ).length,
          unavailable: Object.values(capabilityResult.capabilities).filter(
            (capability) => capability?.state !== "available",
          ).length,
          timed_out: probeTimedOut(capabilityResult),
          ms: Math.round(performance.now() - capabilityStarted),
          cache: cacheStatus,
        });
      }
    }
  } else {
    const defaultsStarted = performance.now();
    defaultsResult = await probeOmpDefaults(defaultsProbe);
    logger.info("omp.defaults_probe", {
      ms: Math.round(performance.now() - defaultsStarted),
      cache: cacheStatus,
    });
  }
  logger.info("omp.probe", {
    status: probe.health.status,
    version: probe.version,
    detail: probe.health.detail,
    ms: ompProbeMs,
    cache: cacheStatus,
  });
  let capabilities = CapabilityMap.parse({});
  if (capabilityResult !== undefined) {
    if (probeTimedOut(capabilityResult)) {
      health = { status: "unhealthy", detail: OMP_PROBLEM.checksTimedOut };
      logger.error("capabilities.probe_failed", {
        message: "the capability probe ran out of time twice",
        cache: cacheStatus,
      });
    } else {
      capabilities = capabilityResult.capabilities;
    }
  }
  if (
    cacheIdentity !== undefined &&
    capabilityResult !== undefined &&
    health.status === "ok" &&
    !probeTimedOut(capabilityResult) &&
    "defaults" in defaultsResult.loaded
  ) {
    await writeProbeCache(
      appDataDir,
      cacheIdentity,
      capabilityResult.raw,
      defaultsResult.loaded.defaults,
      defaultsResult.loaded.registryKeys,
    ).catch((error: unknown) =>
      logger.warn("omp.probe_cache_write_failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  const instanceId = crypto.randomUUID();
  const omp = health.status === "ok" && probe.version !== null ? { version: probe.version } : null;
  const processRegistry = new OmpProcessRegistry({
    ...(options.idleCloseMs === undefined ? {} : { idleCloseMs: options.idleCloseMs }),
    createProcess: (processOptions) => {
      const spawnOptions = {
        ...processOptions,
        chatCommand: chats,
        args: [...(processOptions.args ?? []), ...(options.ompArgs ?? [])],
        env: { ...env, ...processOptions.env },
      };
      return logOmpProcess(
        detachedHosts
          ? spawnDetachedOmpProcess({ ...spawnOptions, hostsDir, systemdScope })
          : spawnOmpProcess(spawnOptions),
        logger,
      );
    },
  });
  const replay = new EventReplayHub();

  const resolveThread: A0PortContext["resolveThread"] = async (threadId, _signal) => {
    const file = await sessionFileStore.resolveThread(threadId);
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
  const usageLimitStore = createUsageLimitStore({ env, command: ompCmd });
  // The server reads the limits itself, so every page follows them and the usage pause judges them (#2781).
  usageLimitStore.watch();
  // Each window's readings over the last day, kept on disk, for its pace on the dashboard (#2836).
  const usageReadings = await UsageReadings.open(join(appDataDir, "usage-readings.json"), {
    logger,
  });
  usageLimitStore.subscribe((result) => usageReadings.add(result));
  const a0Context: A0PortContext = {
    processRegistry,
    newChatsReady,
    usageResumeFile: join(appDataDir, "usage-resume.json"),
    usagePauseFile: join(appDataDir, "usage-pause.json"),
    usageLimits: usageLimitStore,
    usagePace: () => usageReadings.pace(),
    leaseProbe:
      options.leaseProbe ??
      sessionLeaseProbe({ ownersDir: () => ompSessionOwnersDir(env, homeDir) }),
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
    usableModels: () => listUsableModels(ompCmd, env, launchFolder),
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
                omp: { path: ompCmd.join(" "), version: probe.version },
                processes: await listProcesses(process.pid),
                secrets: [launchToken],
              }),
            };
          },
        }),
  };
  const a0Runtime = createA0Runtime(a0Context);
  // D2: the hosts an earlier server left running are taken over before any browser is taken, so a chat that kept running
  // through the restart goes on here. A host on another omp or an older build of the app is restarted on this one between
  // turns (`restartsWhenSettled`); one on another protocol finishes its turn and hands its chat back.
  const own = {
    ompVersion: OMP_VERSION,
    methods: new Set<string>(
      (capabilityResult?.evidence ?? [])
        .filter((each) => each.status === "available")
        .map((each) => each.command),
    ),
    features: new Set<string>(CHAT_HOST_FEATURES),
  };
  if (detachedHosts) {
    const found = await adoptRunningHosts({
      hostsDir,
      protocol: CHAT_HOST_PROTOCOL_VERSION,
      adopt: (process, hello) =>
        a0Runtime.adopt(logOmpProcess(process, logger), hello, {
          restartWhenSettled: restartsWhenSettled(hello, own),
        }),
      handingBack: (threadId) => a0Runtime.handingBack(threadId),
      onFailed: (threadId, error) =>
        logger.warn("omp.host_adopt_failed", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    if (found.adopted + found.handedBack > 0) logger.info("omp.hosts_found", found);
  }
  const sessionFileStore = createServerSessionFileStore({
    sessionsRoot: join(agentDir, "sessions"),
    home: homeDir,
    appDataDir,
    chats: processRegistry,
    // Another omp holds a chat by its lease: the store refuses to delete such a chat, and lists it as held.
    leaseProbe: sessionLeaseProbe({ ownersDir: () => ompSessionOwnersDir(env, homeDir) }),
    views: a0Runtime.views,
  });
  const resolveSession = async (threadId: ThreadId): Promise<CommandSession> => {
    const session = a0Runtime.commandSessionFor(threadId);
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
      command: ompCmd,
      launchDirectory: launchFolder,
      pathEnvironment: env.PATH ?? "",
    },
    defaultsResult,
  );
  const draftStore = createDraftStore({
    env,
    homeDir,
    appDataDir,
    watchRegistry: fileWatch,
    onError: (error) => logger.warn("drafts.error", { detail: error.appError.message }),
  });
  const checkpointStore = new CheckpointStoreService({
    appDataDir,
    onError: (error) => logger.warn("checkpoints.error", { detail: error.appError.message }),
  });
  const attachmentStore = new AttachmentStoreService({
    appDataDir,
    referencedAttachments: () => draftStore.referencedAttachments(),
  });
  const sessionImportStore = createSessionImportStore();
  await attachmentStore.cleanup({ orphanAgeMs: 24 * 60 * 60 * 1000 });
  const ompCommandGateway = createOmpCommandGateway({ resolveSession });
  const backgroundJobStopStore = new BackgroundJobStopStoreService({
    env,
    homeDir,
    appDataDir,
    onError: (error) => logger.warn("background-job-stops.error", { detail: String(error) }),
  });
  const sessionPinStore = createSessionPinStore({
    env,
    homeDir,
    agentDir,
    watchRegistry: fileWatch,
  });
  const modelPreferenceStore = new ModelPreferenceStoreService({ appDataDir });
  const providerAccountStore = createProviderAccountStore({ env, homeDir, agentDir });
  const extensionCatalog = createExtensionCatalog({
    env,
    homeDir,
    agentDir,
    watchRegistry: fileWatch,
  });
  const memoryStore = createMemoryStore({ gateway: ompCommandGateway });
  const ruleStore = createRuleStore({
    env,
    homeDir,
    agentDir,
    watchRegistry: fileWatch,
    onError: (error) => logger.warn("rules.error", { detail: error.appError.message }),
  });
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
  const pasteFileStore = createPasteFileStore();
  // The Files panel (#2782): its uploads and trash under app data; the log names each change's device, known once
  // device pairing below is open (a handler runs only after that).
  const workspaceFiles = createWorkspaceFiles({
    appDataDir,
    fileWatch,
    logger,
    deviceOf: (connectionId) => devices.connections.deviceOf(connectionId),
  });
  const a1Context: A1PortContext = {
    sessionFileStore,
    processBusy: processRegistry,
    processPause: processRegistry,
    processTitles: processRegistry,
    processContinue: a0Runtime.continuing,
    processUsagePause: a0Runtime.usagePauses,
    configStore,
    checkpointStore,
    draftStore,
    ompCommandGateway,
    backgroundJobStopStore,
    sessionPinStore,
    modelPreferenceStore,
    providerAccountStore,
    usageLimitStore,
    usageReadings,
    extensionCatalog,
    memoryStore,
    ruleStore,
    sessionImportStore,
    attachmentStore,
    pasteFileStore,
    workspaceFiles,
    githubRefs,
    urlCatalog,
    planDocumentStore,
    readWorkspaceState,
    searchWorkspaceFiles,
    readHostMetadata,
    publish,
    watchStreamActivity,
    openSessionFile: (threadId) => a0Runtime.sessionFileOf(threadId),
    logger,
  };
  // Device pairing: each device has a key of its own; the address a new device opens is known once the server listens.
  const devices = await openDevicePairing({ appDataDir, logger });
  let appAddress = "";
  let appPort: number | undefined;
  // omp's statistics page, run when the dashboard first opens it (#2836 D6).
  const ompStats = new OmpStats({ command: ompCmd, env, logger });
  // Pages and services of this machine opened to the paired devices (#2788).
  const shares = createSharesRuntime({
    pairing: devices,
    publish,
    chats: () =>
      processRegistry
        .list()
        .flatMap((entry) =>
          entry.pid === undefined ? [] : [{ pid: entry.pid, threadId: entry.threadId }],
        ),
    appPort: () => appPort,
    // Where shares open: the machine's Tailscale address, or the one this names (tests, a machine without Tailscale).
    ...(env.OMP_APP_SHARE_ADDRESS === undefined
      ? {}
      : { address: () => env.OMP_APP_SHARE_ADDRESS ?? null }),
    stats: ompStats,
    logger,
  });
  // The chats that run, from every folder, and an event each time that changes (D1).
  const runningChats = createRunningChatsRuntime({
    held: () => processRegistry.held(),
    waitingFor: (threadId) => a0Runtime.waiting.waitingFor(threadId),
    titleOf: async (threadId) => {
      const file = await sessionFileStore.findSession(threadId);
      if (file === undefined) return null;
      return file.title != null ? sessionDisplayTitle(file.title) : (file.firstPrompt ?? null);
    },
    sessionFileOf: (threadId) => a0Runtime.sessionFileOf(threadId),
    changes: [
      (listener) => processRegistry.onHeldChange(listener),
      (listener) => processRegistry.onBusyChange(() => listener()),
      (listener) => processRegistry.onPauseChange(() => listener()),
      (listener) => a0Runtime.waiting.onWaitingChange(listener),
    ],
    publish,
    views: {
      viewsOf: (threadId, connectionId) => a0Runtime.views.viewsOf(threadId, connectionId),
      watcherCount: (threadId) => a0Runtime.views.watcherCount(threadId),
    },
    busyOf: (threadId) => processRegistry.busyOf(threadId),
    abortTurn: (threadId, call) => a0Runtime.abortTurn(threadId, call),
    stopChat: (threadId, ownViews) => processRegistry.stop(threadId, ownViews),
  });
  // The browsers chats use (Browser and relay control, B1-B7): the app's own (a Chrome on this machine with its own
  // profile, shown in the Browser panel; none when no Chrome is found) or the user's Edge through omp's relay, run here
  // while chosen. Chosen in the panel: omp's `browser.cdpUrl` or `browser.relay`, every folder.
  const chrome = findChrome(env);
  const browserRuntime = createBrowserRuntime({
    browser:
      chrome === null
        ? null
        : new ServerBrowser({
            chrome,
            profileDir: join(appDataDir, "server-browser", "profile"),
            port: Number(env.OMP_APP_BROWSER_PORT ?? SERVER_BROWSER_PORT),
            noSandbox: env.OMP_APP_BROWSER_NO_SANDBOX === "1",
            logger,
          }),
    edge: new EdgeRelay({ port: EDGE_RELAY_PORT, logger }),
    // The laptop's end listens on its own loopback only, and ssh stops when the forward fails instead of running on
    // unforwarded (#2796).
    edgeLink: `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${EDGE_RELAY_PORT}:127.0.0.1:${EDGE_RELAY_PORT} ${userInfo().username}@${hostname()}`,
    // When "Your own browser", chosen in the panel, turns itself off: kept across restarts in the app's data folder.
    edgeChoice: {
      read: async () => {
        const until = await Bun.file(join(appDataDir, "browser-edge.json"))
          .json()
          .then((saved: { until?: unknown }) => saved.until)
          .catch(() => null);
        return typeof until === "number" ? until : null;
      },
      write: async (until) => {
        const file = join(appDataDir, "browser-edge.json");
        if (until === null) await rm(file, { force: true });
        else await Bun.write(file, JSON.stringify({ until }));
      },
    },
    ...(env.OMP_APP_EDGE_MINUTES === undefined
      ? {}
      : { edgeMinutes: Number(env.OMP_APP_EDGE_MINUTES) }),
    settings: {
      read: async (key) => {
        // A key no layer sets (no default either, as `browser.cdpUrl`) is "not found" to the store: here it is unset.
        const entry = await configStore.read({ key, folder: null }).catch((error: unknown) => {
          if (error instanceof AppFailure && error.appError.code === "not_found") return null;
          throw error;
        });
        return entry !== null &&
          !entry.secret &&
          entry.source === "global" &&
          (typeof entry.value === "string" || typeof entry.value === "boolean")
          ? entry.value
          : null;
      },
      write: async (key, value) => {
        const { revision } = await configStore.list({ prefix: key, folder: null });
        if (value === null)
          await configStore.unset({
            key,
            layer: "global",
            folder: null,
            expectedRevision: revision,
          });
        else
          await configStore.write({
            key,
            layer: "global",
            value: { secret: false, value },
            folder: null,
            expectedRevision: revision,
          });
      },
    },
    publish,
    publishLive: replay.publishLive.bind(replay),
    watchStreams: watchStreamActivity,
    logger,
  });
  const registry: PortRegistry = createPortRegistry([
    ...a0Runtime.registrations,
    createDevicesPortRegistration({
      pairing: devices,
      publish,
      address: () => appAddress,
      logger,
    }),
    shares.registration,
    runningChats.registration,
    browserRuntime.registration,
    ...createA1PortRegistrations(a1Context),
  ]);
  const staticRoot = options.staticRoot ?? resolve(import.meta.dir, "../../..", "apps/web/dist");
  const uiRoot = options.uiRoot ?? resolve(import.meta.dir, "../../..", "apps/ui/dist");
  const launchHistory = openLaunchHistory(appDataDir, logger);
  const server = createAppServer({
    ...(options.token === undefined ? {} : { token: options.token }),
    port: options.port,
    instanceId,
    serverVersion,
    omp,
    capabilities,
    replay,
    staticRoot,
    uiRoot,
    registry,
    logger,
    earlierLaunchTokens: launchHistory.earlier,
    ...(remote === undefined ? {} : { remote }),
    ...(frameAncestors.length === 0 ? {} : { frameAncestors }),
    devices,
  });
  appAddress = remote?.origin ?? server.url;
  appPort = server.port;
  await launchHistory.remember(server.token);
  launchToken = server.token;
  logger.addSecret(server.token);
  logger.info("listening", {
    port: server.port,
    health: health.status,
    detail: health.detail,
    remote: remote?.origin ?? "none",
    frame_ancestors: frameAncestors.length === 0 ? "none" : frameAncestors.join(" "),
  });
  const stats = startStatsSampler({
    logger,
    processes: () => processRegistry.list(),
    ...(options.statsIntervalMs === undefined ? {} : { intervalMs: options.statsIntervalMs }),
  });
  return {
    ...server,
    processRegistry,
    health,
    remoteUrl: remote?.origin,
    async stop() {
      try {
        stats.stop();
        logger.info("stop");
        await server.stop();
      } finally {
        try {
          try {
            // The new chats kept ready stop with their hosts: a later server could resume nothing in them, and one that
            // found them would keep each for an hour. Every chat's host is then let go to the next server (D2).
            await a0Runtime.dispose();
          } finally {
            await processRegistry.closeAll();
          }
        } finally {
          await sessionFileStore.close();
          urlCatalog.dispose();
          extensionCatalog.dispose();
          ruleStore.dispose();
          attachmentStore.dispose();
          configStore.dispose();
          draftStore.dispose();
          sessionPinStore.dispose();
          memoryStore.dispose();
          devices.desk.dispose();
          shares.stop();
          ompStats.stop();
          usageLimitStore.dispose();
          runningChats.stop();
          await browserRuntime.stop();
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
