/**
 * One chat's session, built the way omp builds it for a chat launched with `--mode rpc-ui` (`runRootCommand`, omp
 * 18.12.6 `main.ts:1776-2560`), on omp's SDK (`createAgentSession`). The chat host runs one chat per process, in the
 * chat's folder, so omp's process-wide steps are this chat's own.
 *
 * omp's steps in its order (`main.ts` lines), and what happens to each here:
 * - kept, in the same order: the theme (1786); the start folder (`applyStartupCwd`, 1790); `@file` refused (1824); the
 *   plugin-root preload (1840) and the command-line extension roots (1850); the goal and restore checks (1881); not an
 *   interactive host (1901); settings with `--config` (1908); auth discovery and its settings sync (1912-1928); the
 *   approval mode (1929); the protocol defaults (1938); the model registry, its credential caches and the runtime
 *   identity (1946-1961); `PI_NO_PTY` (1962-1972); `initializeWithSettings` (1975); the model role
 *   overrides (1978); `--hide-thinking`, `--advisor`, `--external-thinking` (1997-2007); `initTheme` (2009); the scoped
 *   models (2040); `--continue <id>` (2051); `--from-*` refused (2061); the session manager (2118); the resume folder
 *   switch (2135, `switchToResumedProject` below, copied from `main.ts:947` because it is not exported); the pending
 *   tool-call warning (2239); the daemon presence (2256); the marketplace auto-update (2262); the session options with
 *   the rpc-ui values (2268-2288); telemetry export (2295); `--api-key` (2310); the extensions and their flags
 *   (2383-2446); `createAgentSession` with the background model refresh (2323, 2504); the retry-chain and tool-name
 *   checks (2522-2536); the subagent reviver (2545); the scoped-model rebuild and watch (2574-2600); the model checks
 *   (2617-2668); the settings watcher (2670).
 * - changed: a launch error throws (omp writes it to stderr and exits; `chat.ts` does that for this process); notices
 *   omp prints in a protocol mode go to stderr, as there; a session file whose folder is gone is not moved (omp asks on
 *   a terminal; a protocol host has none, so its answer is "unavailable", as omp's own `promptMoveSession` gives); and
 *   omp names the chat, as on its terminal (`autoTitle`, `title.generator`), where a protocol launch sets
 *   `PI_NO_TITLE` and leaves it unnamed: the app shows a chat's title (#2798).
 * - skipped, because no terminal runs here: the start-up watchdog (1782), piped input (1869), the start-up composer
 *   (2019), the session picker of a bare `--resume` (2169, refused), the Warp event bridge (2375), the splash, the
 *   changelog and the Python probe (2462-2502).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import {
  type Args,
  parseArgs,
  validateGoalLaunch,
  validateGoalStartup,
  validateRestoreLaunch,
  validateRestorePrompt,
  validateToolNames,
} from "@oh-my-pi/pi-coding-agent/cli/args";
import {
  applyExtensionFlags,
  type ExtensionFlagSink,
} from "@oh-my-pi/pi-coding-agent/cli/extension-flags";
import { applyStartupCwd } from "@oh-my-pi/pi-coding-agent/cli/startup-cwd";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { all, type ProtocolHost } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import {
  clearPluginRootsAndCaches,
  injectPluginDirRoots,
  preloadPluginRoots,
  resolveActiveProjectRegistryPath,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { injectOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { formatExtensionLoadNotifications } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/load-errors";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { scheduleMarketplaceAutoUpdate } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace-auto-update";
import { cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { registerDaemonProjectPresence } from "@oh-my-pi/pi-coding-agent/launch/presence";
import {
  buildSessionOptions,
  createSessionManager,
  normalizeContinueSessionArgs,
  rebuildScopedModels,
  resolveScopedModels,
  SessionResolutionError,
  watchScopedModelSettings,
} from "@oh-my-pi/pi-coding-agent/main";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
  cfgColorBlindMode,
  cfgMarketplaceAutoUpdate,
  cfgSymbolPreset,
  cfgThemeDark,
  cfgThemeLight,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
  cfgPlanDefaultOnStartup,
  cfgPlanEnabled,
} from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
  type CreateAgentSessionResult,
  createAgentSession,
  discoverAuthStorage,
  loadSessionExtensions,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
  createAuthStorageSettingsSync,
  describeAuthBrokerStartupError,
} from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { describePendingToolCalls } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { loadRuntimeIdentity } from "@oh-my-pi/pi-coding-agent/session/runtime-identity";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
  cfgExternalThinking,
  cfgHideThinkingBlock,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { cfgTaskAgentIdleTtlMs } from "@oh-my-pi/pi-coding-agent/task/settings";
import {
  createTelemetryExportConfig,
  initTelemetryExport,
  isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { cfgTelemetryOtlpExportEnabled } from "@oh-my-pi/pi-coding-agent/telemetry-settings";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { ensureTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import {
  directoryIsMissing,
  getProjectDir,
  normalizePathForComparison,
  setProjectDir,
} from "@oh-my-pi/pi-utils/dirs";
import { $env, setInteractiveHost } from "@oh-my-pi/pi-utils/env";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { HOST_FILES_TOOLS, hostFilesNote } from "./host-files";
import { AskAsyncTool } from "./questions";
import { SharedTodosTool } from "./shared-todos";

/** One chat's session, ready for the loop. */
export interface ChatSession {
  readonly session: AgentSession;
  readonly setToolUIContext: CreateAgentSessionResult["setToolUIContext"];
  readonly mcpManager: MCPManager | undefined;
  readonly subagentEventBus: EventBus;
  /** The app's `ask_async` tool in the session; the loop gives it the chat's questions. */
  readonly askAsync: AskAsyncTool;
  /** The app's `shared_todos` tool; the loop gives it the host's line to the server. */
  readonly sharedTodos: SharedTodosTool;
}

/** Where omp's launch notices go: omp prints them on stderr in a protocol mode, and so does the chat host. */
export type NoticeSink = (message: string) => void;

/** What the app tells a chat beside omp's flags. */
export interface ChatSessionOptions {
  /**
   * The chat's files are on the computer of this app (`vscode`), which shows the chat in a panel and gives it the tools
   * that reach them (`host-files.ts`): omp's own file, shell and code tools are left out.
   */
  readonly filesOnHost?: string;
}

/**
 * Builds the chat's session from its launch flags (`--resume <file>`, `--model …`, `--allow-home`, …), in the process
 * folder the server started the host in. Rejects with a readable message when the chat cannot start.
 */
export async function createChatSession(
  rawArgs: readonly string[],
  notice: NoticeSink,
  options: ChatSessionOptions = {},
): Promise<ChatSession> {
  const args = [...rawArgs];
  await ensureTheme();
  const parsed = parseArgs(args);
  await applyStartupCwd(parsed);
  if (parsed.fileArgs.length > 0) {
    throw new Error("@file arguments are not supported in an app chat");
  }

  const home = os.homedir();
  const pluginPreload =
    parsed.pluginDirs && parsed.pluginDirs.length > 0
      ? injectPluginDirRoots(home, parsed.pluginDirs, getProjectDir())
      : preloadPluginRoots(home, getProjectDir());
  // Awaited below; this keeps an early failure from also being an unhandled rejection.
  pluginPreload.catch(() => undefined);
  if (!parsed.trustedExtensions?.length) {
    injectOmpExtensionCliRoots(
      [...(parsed.extensions ?? []), ...(parsed.hooks ?? [])],
      home,
      getProjectDir(),
      { mode: parsed.noExtensions ? "explicit-only" : "merge", replace: true },
    );
  }

  let cwd = getProjectDir();
  validateGoalLaunch(parsed, false);
  validateRestoreLaunch(parsed, false);
  setInteractiveHost(false);

  const settings = await Settings.init({ cwd, configFiles: parsed.config });
  let authStorage: AuthStorage;
  try {
    authStorage = await discoverAuthStorage(undefined, { settings });
  } catch (error) {
    const message = await describeAuthBrokerStartupError(error);
    if (message === null) throw error;
    throw new Error(message);
  }
  createAuthStorageSettingsSync(settings, authStorage);
  if (parsed.approvalMode) {
    cfgToolsApprovalMode.override(settings, parsed.approvalMode);
  } else if (parsed.autoApprove) {
    cfgToolsApprovalMode.override(settings, "yolo");
  }
  applyProtocolDefaults("rpc", settings);

  const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
  const credentialScopedCaches = modelRegistry.hydrateCredentialScopedModelCaches();
  const runtimeIdentity = loadRuntimeIdentity();
  Bun.env.PI_NO_PTY = "1";
  // No `PI_NO_TITLE`: omp names the chat (`autoTitle` below, #2798).
  initializeWithSettings(settings);
  const smol = parsed.smol ?? $env.PI_SMOL_MODEL;
  const slow = parsed.slow ?? $env.PI_SLOW_MODEL;
  const plan = parsed.plan ?? $env.PI_PLAN_MODEL;
  if (smol || slow || plan) settings.overrideModelRoles({ smol, slow, plan });
  if (parsed.hideThinking) cfgHideThinkingBlock.override(settings, true);
  if (parsed.advisor) cfgAdvisorEnabled.override(settings, true);
  if (parsed.externalThinking) cfgExternalThinking.override(settings, true);
  await initTheme(
    false,
    cfgSymbolPreset.get(settings),
    cfgColorBlindMode.get(settings),
    cfgThemeDark.get(settings),
    cfgThemeLight.get(settings),
  );

  await credentialScopedCaches;
  let scopedModels = await resolveScopedModels(parsed, modelRegistry, settings);
  normalizeContinueSessionArgs(parsed, args);
  await runtimeIdentity;

  if (parsed.fromClaude || parsed.fromCodex) {
    throw new SessionResolutionError(
      `--from-${parsed.fromClaude ? "claude" : "codex"} is not supported in an app chat`,
    );
  }
  if (parsed.resume === true && !parsed.fork && !parsed.noSession) {
    throw new SessionResolutionError(
      "--resume needs the session to resume: an app chat has no session picker",
    );
  }
  const sessionManager = await createSessionManager(parsed, cwd, settings, cannotAskToMove, {
    nativeFlagOwnership: "preliminary",
  });
  if (typeof parsed.resume === "string" && !sessionManager) {
    throw new SessionResolutionError("Resume cancelled: the session was not moved.");
  }
  if (typeof parsed.resume === "string" && sessionManager && !parsed.noSession) {
    const previousCwd = cwd;
    const resumed = await switchToResumedProject(
      sessionManager.getRecordedCwd() ?? sessionManager.getCwd(),
      settings,
      pluginPreload,
      sessionManager,
    );
    cwd = resumed.cwd;
    if (resumed.chdirFailed !== undefined) {
      notice(`Could not switch to resumed project ${resumed.chdirFailed}; staying in ${cwd}.`);
    }
    if (cwd !== previousCwd) {
      parsed.cwd = cwd;
      scopedModels = await resolveScopedModels(parsed, modelRegistry, settings);
    }
  }
  if (sessionManager && (parsed.continue || parsed.resume || parsed.fork)) {
    const pendingToolWarning = describePendingToolCalls(sessionManager.getBranch());
    if (pendingToolWarning) notice(pendingToolWarning);
  }
  await pluginPreload;
  const daemonPresence = registerDaemonProjectPresence(cwd);
  daemonPresence.catch(() => undefined);
  scheduleMarketplaceAutoUpdate({
    autoUpdate: cfgMarketplaceAutoUpdate.get(settings),
    resolveActiveProjectRegistryPath,
    clearPluginRootsCache: clearPluginRootsAndCaches,
  });

  const sessionOptions = await buildSessionOptions(
    parsed,
    scopedModels,
    sessionManager,
    modelRegistry,
    settings,
  );
  sessionOptions.authStorage = authStorage;
  sessionOptions.modelRegistry = modelRegistry;
  // The values omp gives a `--mode rpc-ui` launch: a UI exists (the app), and nothing terminal-only runs.
  sessionOptions.hasUI = true;
  sessionOptions.allowSessionModelFallback = false;
  sessionOptions.settingsApproval = false;
  sessionOptions.tuiTranscript = false;
  // As omp's terminal does: omp names an untitled chat from its first message once the reply starts (`title.generator`).
  sessionOptions.autoTitle = true;
  sessionOptions.settings = settings;
  sessionOptions.onPrewalkWarning = (warning) => notice(`Warning: ${warning}`);
  if (options.filesOnHost !== undefined) {
    // omp's built-ins narrowed to the ones that do not work on this computer's files (`--tools` does the same).
    sessionOptions.toolNames = [...HOST_FILES_TOOLS];
    sessionOptions.appendSystemPrompt = [
      sessionOptions.appendSystemPrompt,
      hostFilesNote(options.filesOnHost),
    ]
      .filter((part) => part !== undefined && part !== "")
      .join("\n\n");
  }
  await initTelemetryExport(cfgTelemetryOtlpExportEnabled.get(settings));
  if (isTelemetryExportEnabled()) {
    sessionOptions.telemetry = createTelemetryExportConfig(
      sessionOptions.telemetry,
      (providerId, modelId) => {
        const model = modelRegistry.find(providerId, modelId);
        return model !== undefined && getModelPricingStatus(model) !== "unknown";
      },
    );
  }
  await daemonPresence;
  if (parsed.apiKey) {
    if (!sessionOptions.model && !sessionOptions.modelPattern) {
      throw new Error(
        "--api-key requires a model to be specified via --model, --provider/--model, or --models",
      );
    }
    if (sessionOptions.model)
      authStorage.keys.setRuntime(sessionOptions.model.provider, parsed.apiKey);
  }

  const eventBus = new EventBus();
  const subagentEventBus = new EventBus();
  const extensions: LoadExtensionsResult & { readonly deferredPaths: readonly string[] } =
    parsed.trustedExtensions && parsed.trustedExtensions.length > 0
      ? {
          ...(await loadTrustedExtensions(parsed.trustedExtensions, cwd, eventBus)),
          deferredPaths: [],
        }
      : await loadSessionExtensions(sessionOptions, cwd, settings, eventBus, {
          deferStartupSafe: false,
        });
  const flagSink: ExtensionFlagSink = {
    getFlags: () => ExtensionRunner.aggregateFlags(extensions.extensions),
    setFlagValue: (name, value) => {
      extensions.runtime.flagValues.set(name, value);
    },
  };
  const initialArgs: Args = applyExtensionFlags(flagSink, args) ?? parsed;
  normalizeContinueSessionArgs(initialArgs, args);
  validateSessionPersistenceArgs(initialArgs);
  if ((parsed.trustedExtensions?.length ?? 0) > 0 && extensions.errors.length > 0) {
    throw new Error(
      `Trusted extension failed to load: ${extensions.errors.map((item) => item.error).join("; ")}`,
    );
  }
  for (const message of formatExtensionLoadNotifications(extensions.errors)) notice(message);
  if (initialArgs.invalidFlagValues.length > 0 || initialArgs.unrecognizedFlags.length > 0) {
    const problems = [
      ...initialArgs.invalidFlagValues,
      ...initialArgs.unrecognizedFlags.map((flag) => `unknown flag ${flag}`),
    ];
    throw new Error(`omp could not start this chat: ${problems.join("; ")}`);
  }
  validateRestorePrompt(initialArgs);
  if (initialArgs.goal !== undefined) {
    validateGoalStartup(
      initialArgs,
      cfgGoalEnabled.get(settings),
      undefined,
      cfgPlanDefaultOnStartup.get(settings) && cfgPlanEnabled.get(settings),
    );
  }

  // The app's own tools, beside omp's: questions the agent asks without waiting (`questions.ts`), and the to-do list it
  // shares with the person and the other chats (`shared-todos.ts`).
  const askAsync = new AskAsyncTool();
  const sharedTodos = new SharedTodosTool();
  const created = await createAgentSession({
    ...sessionOptions,
    customTools: [askAsync.definition, sharedTodos.definition],
    eventBus,
    subagentEventBus,
    preloadedExtensions: extensions,
    deferredExtensionPaths: [...extensions.deferredPaths],
    deferRetryFallbackValidation: true,
  });
  modelRegistry.refreshInBackground();
  const { session } = created;
  try {
    session.validateRetryFallbackChains();
    validateToolNames(initialArgs.tools, session.getAllToolNames());
    AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
      createPersistedSubagentReviverFactory({
        session,
        authStorage,
        modelRegistry,
        settings,
        enableLsp: sessionOptions.enableLsp ?? true,
        eventBus,
        subagentEventBus,
      }),
      () => Math.trunc(Number(cfgTaskAgentIdleTtlMs.get(settings)) || 0),
    );
    if (parsed.apiKey && !sessionOptions.model && session.model) {
      authStorage.keys.setRuntime(session.model.provider, parsed.apiKey);
    }
    if ((parsed.models ?? cfgEnabledModels.get(settings)).length > 0) {
      await rebuildScopedModels(session, parsed, modelRegistry, settings);
    }
    watchScopedModelSettings(session, parsed, modelRegistry, settings);
    for (const warning of modelRegistry.drainConfigWarnings()) notice(`Warning: ${warning}`);
    if (!session.model) {
      throw new Error(
        modelRegistry.getError()?.message ??
          created.modelFallbackMessage ??
          "No models available. Set an API key, or pick a model that omp can use.",
      );
    }
  } catch (error) {
    await session.dispose().catch(() => undefined);
    throw error;
  }
  settings.startWatching();
  postmortem.register("settings-file-watcher", () => settings.stopWatching(), { exitOnly: true });
  return {
    session,
    setToolUIContext: created.setToolUIContext,
    mcpManager: created.mcpManager,
    subagentEventBus,
    askAsync,
    sharedTodos,
  };
}

/** omp's `applyProtocolDefaults` (`main.ts:266`, not exported): a protocol host starts from omp's neutral defaults. */
function applyProtocolDefaults(host: ProtocolHost, target: Settings): void {
  for (const setting of all()) {
    if (setting.definition.protocolDefault?.includes(host)) setting.pinDefault(target);
  }
}

/** omp's answer when no terminal can ask to move a session whose folder is gone (`promptMoveSession`, `main.ts:833`). */
async function cannotAskToMove(): Promise<"unavailable"> {
  return "unavailable";
}

/** omp's `validateSessionPersistenceArgs` (`main.ts:1213`, not exported). */
function validateSessionPersistenceArgs(
  parsed: Pick<Args, "continue" | "noSession" | "resume">,
): void {
  if (!parsed.noSession) return;
  if (parsed.resume !== undefined)
    throw new SessionResolutionError("--resume requires session persistence");
  if (parsed.continue) throw new SessionResolutionError("--continue requires session persistence");
}

/** omp's `loadTrustedSessionExtensions` (`main.ts:512`, not exported): trusted files load as exact module paths. */
async function loadTrustedExtensions(
  paths: readonly string[],
  cwd: string,
  eventBus: EventBus,
): Promise<LoadExtensionsResult> {
  for (const trustedPath of paths) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(trustedPath);
    } catch {
      throw new Error(`Trusted extension must be an existing module file: ${trustedPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Trusted extension must be a module file, not a directory: ${trustedPath}`);
    }
  }
  return loadExtensions([...paths], cwd, eventBus);
}

interface ResumedProject {
  readonly cwd: string;
  readonly chdirFailed?: string;
}

/**
 * omp's `switchToResumedProject` (`main.ts:947-1005`, not exported): a resumed session recorded in another folder moves
 * the process there, re-reads the plugin roots and the settings for it, and rolls back to the launch folder if that
 * fails.
 */
async function switchToResumedProject(
  resumedCwd: string | undefined,
  settings: Settings,
  pluginPreload: Promise<unknown>,
  sessionManager: SessionManager,
): Promise<ResumedProject> {
  const launchCwd = getProjectDir();
  if (
    !resumedCwd ||
    normalizePathForComparison(resumedCwd) === normalizePathForComparison(launchCwd) ||
    (await directoryIsMissing(resumedCwd))
  ) {
    return { cwd: launchCwd };
  }
  await pluginPreload.catch(() => undefined);
  try {
    setProjectDir(resumedCwd);
  } catch {
    sessionManager.setCwdWithoutRelocation(launchCwd);
    return { cwd: launchCwd, chdirFailed: resumedCwd };
  }
  clearPluginRootsAndCaches();
  resetCapabilities();
  const cwd = getProjectDir();
  try {
    await preloadPluginRoots(os.homedir(), cwd);
    await settings.reloadForCwd(cwd);
    if (normalizePathForComparison(sessionManager.getCwd()) !== normalizePathForComparison(cwd)) {
      sessionManager.adoptRecordedCwd();
    }
  } catch (error) {
    try {
      setProjectDir(launchCwd);
      sessionManager.setCwdWithoutRelocation(launchCwd);
      clearPluginRootsAndCaches();
      await preloadPluginRoots(os.homedir(), launchCwd);
      await settings.reloadForCwd(launchCwd);
    } catch (rollbackError) {
      throw new SessionResolutionError(
        `Could not switch to resumed project ${resumedCwd} (${error instanceof Error ? error.message : String(error)}); failed to restore launch directory ${launchCwd}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    return { cwd: launchCwd, chdirFailed: resumedCwd };
  }
  return { cwd };
}
