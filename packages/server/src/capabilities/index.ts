import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AppFailure,
  type CapabilityKey,
  CapabilityMap,
  type CapabilityStatus,
  D8_AP6_UNAVAILABLE_REASONS,
  FolderPath,
  OMP_COMMAND_NAMES,
  type OmpCommand,
  type OmpCommandName,
  ThreadId,
} from "@omp-app/contracts";
import { RpcSession } from "@omp-app/omp-rpc";
import { spawnOmpProcess } from "../process";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_GH_TIMEOUT_MS = 2_000;
const DEFAULT_PROBE_DEADLINE_MS = 15_000;
/** What a probe that ran out of time is retried with: a busy computer needs longer than a quiet one. */
export const PATIENT_PROBE_TIMEOUT_MS = 20_000;
export const PATIENT_PROBE_DEADLINE_MS = 60_000;
const PROBE_TIMEOUT_REASON =
  "omp capability probe timed out before all capabilities were confirmed";
const COMMAND_TIMEOUT_REASON = "omp did not return a command response before the probe timed out";
const PROBE_OMP_ARGS = [
  "--no-session",
  "--no-title",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
] as const;
export const RPC_NO_SESSION_SOURCE =
  "omp-v18.12.6:packages/coding-agent/src/cli/flag-tables.ts:316-319; cli/args.ts:350-353";

/** The source of the generic unknown-command branch used by all command probes. */
export const RPC_UNKNOWN_COMMAND_SOURCE =
  "omp-v18.12.6:packages/coding-agent/src/modes/rpc/rpc-mode.ts:2675-2678";
/** The source of the response/error contract used to classify invalid arguments. */
export const RPC_INVALID_ARGUMENT_SOURCE =
  "omp-v18.12.6:packages/coding-agent/src/modes/rpc/rpc-mode.ts:1936-1941,2656-2658; docs/rpc.md:115-120,304-311";

/**
 * Commands the app does not send yet, so the probe does not send them either. A bare frame is a valid
 * call for `btw_cancel` (it cancels the running side question). The other four either need arguments
 * the probe does not have or only read, and the app has no use for them yet. Each reports unavailable
 * with `NOT_PROBED_REASON`.
 */
const UNPROBED_COMMANDS: ReadonlySet<OmpCommandName> = new Set<OmpCommandName>([
  "get_logout_accounts",
  "logout",
  "btw",
  "btw_cancel",
  "get_btw_history",
]);
const NOT_PROBED_REASON = "not probed: the app does not send this command yet";

const MCP_RECONNECT_UNAVAILABLE: CapabilityStatus = {
  state: "unavailable",
  via: "upstream",
  detail: "Reconnect this MCP server in the omp terminal; this app cannot reconnect it.",
};

/**
 * Host seams that are registered by the A1 bridge and do not require an omp probe. Every `host.*`
 * capability an A1 port registration declares must be listed here (except `host.github-refs`, which
 * the gh probe below decides); `ports.test.ts` fails when one is missing, because an unlisted
 * capability reaches the browser as unavailable even though the server handles it.
 */
export const DEFAULT_HOST_CAPABILITIES = [
  "host.attachments",
  "host.checkpoints",
  "host.command-gateway",
  "host.config",
  "host.drafts",
  "host.extension-catalog",
  "host.file-search",
  "host.git-state",
  "host.metadata",
  "host.mcp",
  "host.memory-store",
  "host.plan-documents",
  "host.provider-accounts",
  "host.rules",
  "host.session-files",
  "host.session-import",
  "host.session-pins",
  "host.url-catalog",
  "host.usage-limits",
  "host.workspace-state",
] as const satisfies readonly CapabilityKey[];

export type CommandProbeKind = "read-only" | "invalid-arguments";

export interface CommandProbeEvidence {
  readonly kind: CommandProbeKind;
  /** The command's canonical schema documentation, plus the dispatcher/error sources. */
  readonly source: string;
}

const COMMAND_DOCUMENTATION_SOURCE: Readonly<Record<OmpCommandName, string>> = {
  negotiate_protocol: "omp-v18.12.6:docs/rpc.md:139-142",
  prompt: "omp-v18.12.6:docs/rpc.md:126-137",
  steer: "omp-v18.12.6:docs/rpc.md:126-137",
  follow_up: "omp-v18.12.6:docs/rpc.md:126-137",
  remove_queued_message: "omp-v18.12.6:docs/rpc.md:126-137",
  promote_queued_message: "omp-v18.12.6:docs/rpc.md:126-137",
  abort: "omp-v18.12.6:docs/rpc.md:126-137",
  abort_and_prompt: "omp-v18.12.6:docs/rpc.md:126-137",
  abort_and_restore_queue: "omp-v18.12.6:docs/rpc.md:135,415-421",
  new_session: "omp-v18.12.6:docs/rpc.md:126-137",
  open_session: "omp-v18.12.6:docs/rpc.md:126-137",
  get_state: "omp-v18.12.6:docs/rpc.md:143-152",
  set_fast_mode: "omp-v18.12.6:docs/rpc.md:143-152",
  set_slow_mode: "omp-v18.12.6:docs/rpc.md:147,580-611",
  goal: "omp-v18.12.6:docs/rpc.md:143-152",
  set_ask_dialog: "omp-v18.12.6:docs/rpc.md:143-152",
  get_available_commands: "omp-v18.12.6:docs/rpc.md:143-152",
  get_entries: "omp-v18.12.6:docs/rpc.md:143-152",
  get_tree: "omp-v18.12.6:docs/rpc.md:143-152",
  set_todos: "omp-v18.12.6:docs/rpc.md:143-152",
  set_host_tools: "omp-v18.12.6:docs/rpc.md:143-152",
  set_host_uri_schemes: "omp-v18.12.6:docs/rpc.md:143-152",
  set_subagent_subscription: "omp-v18.12.6:docs/rpc.md:143-152",
  set_event_filter: "omp-v18.12.6:docs/rpc.md:143-152",
  get_subagents: "omp-v18.12.6:docs/rpc.md:143-152",
  get_subagent_messages: "omp-v18.12.6:docs/rpc.md:143-152",
  cancel_subagent: "omp-v18.12.6:docs/rpc.md:143-152",
  steer_subagent: "omp-v18.12.6:docs/rpc.md:143-152",
  live_start: "omp-v18.12.6:packages/coding-agent/src/modes/rpc/rpc-types.ts:76-78",
  live_stop: "omp-v18.12.6:packages/coding-agent/src/modes/rpc/rpc-types.ts:76-78",
  live_mute: "omp-v18.12.6:packages/coding-agent/src/modes/rpc/rpc-types.ts:76-78",
  set_model: "omp-v18.12.6:docs/rpc.md:163-169",
  cycle_model: "omp-v18.12.6:docs/rpc.md:163-169",
  get_available_models: "omp-v18.12.6:docs/rpc.md:163-169",
  set_thinking_level: "omp-v18.12.6:docs/rpc.md:171-177",
  cycle_thinking_level: "omp-v18.12.6:docs/rpc.md:171-177",
  get_available_thinking_levels: "omp-v18.12.6:docs/rpc.md:171-177",
  set_steering_mode: "omp-v18.12.6:docs/rpc.md:179-183",
  set_follow_up_mode: "omp-v18.12.6:docs/rpc.md:179-183",
  set_interrupt_mode: "omp-v18.12.6:docs/rpc.md:179-183",
  compact: "omp-v18.12.6:docs/rpc.md:185-188",
  set_auto_compaction: "omp-v18.12.6:docs/rpc.md:185-188",
  set_cache_warming: "omp-v18.12.6:docs/rpc.md:190-205",
  set_auto_retry: "omp-v18.12.6:docs/rpc.md:207-210",
  abort_retry: "omp-v18.12.6:docs/rpc.md:207-210",
  bash: "omp-v18.12.6:docs/rpc.md:212-222",
  abort_bash: "omp-v18.12.6:docs/rpc.md:212-222",
  get_session_stats: "omp-v18.12.6:docs/rpc.md:224-236",
  export_html: "omp-v18.12.6:docs/rpc.md:224-236",
  switch_session: "omp-v18.12.6:docs/rpc.md:224-236",
  branch: "omp-v18.12.6:docs/rpc.md:224-236",
  fork: "omp-v18.12.6:docs/rpc.md:224-236",
  get_branch_messages: "omp-v18.12.6:docs/rpc.md:224-236",
  get_last_assistant_text: "omp-v18.12.6:docs/rpc.md:224-236",
  set_session_name: "omp-v18.12.6:docs/rpc.md:224-236",
  handoff: "omp-v18.12.6:docs/rpc.md:224-236",
  get_messages: "omp-v18.12.6:docs/rpc.md:240-247",
  get_messages_page: "omp-v18.12.6:docs/rpc.md:240-247",
  get_login_providers: "omp-v18.12.6:docs/rpc.md:249-259",
  login: "omp-v18.12.6:docs/rpc.md:249-259",
  get_logout_accounts: "omp-v18.12.6:docs/rpc.md:253-254,262-264",
  logout: "omp-v18.12.6:docs/rpc.md:253-254,262-264",
  predict_word: "omp-v18.12.6:docs/rpc.md:269-294",
  predict_word_feedback: "omp-v18.12.6:docs/rpc.md:269-294",
  btw: "omp-v18.12.6:docs/rpc.md:298,1071-1137",
  btw_cancel: "omp-v18.12.6:docs/rpc.md:299,1104-1110",
  get_btw_history: "omp-v18.12.6:docs/rpc.md:300,1113-1116",
};

export const COMMAND_PROBE_EVIDENCE: Readonly<Record<OmpCommandName, CommandProbeEvidence>> =
  Object.fromEntries(
    OMP_COMMAND_NAMES.map((command) => [
      command,
      {
        kind: command.startsWith("get_") ? "read-only" : "invalid-arguments",
        source: `${COMMAND_DOCUMENTATION_SOURCE[command]}; ${RPC_UNKNOWN_COMMAND_SOURCE}; ${RPC_INVALID_ARGUMENT_SOURCE}`,
      },
    ]),
  ) as Record<OmpCommandName, CommandProbeEvidence>;

export interface CapabilityProbeOptions {
  /** The isolated cwd for the short-lived probe process, normally a directory under app data. */
  readonly cwd: FolderPath;
  /** The command that starts a chat (`chatCommand()` in `omp-host/chat-command.ts`), or a test's stand-in. */
  readonly chatCommand: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Maximum time allowed for an individual omp command. */
  readonly timeoutMs?: number;
  /** Maximum time allowed for startup and the complete command loop. */
  readonly deadlineMs?: number;
  readonly ghBinary?: string;
  readonly hostCapabilities?: readonly CapabilityKey[];
}

export interface CapabilityProbeEvidenceResult {
  readonly command: OmpCommandName;
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly source: string;
}

export interface CapabilityProbeCommandResult {
  readonly available: boolean;
  readonly reason?: string;
}

export interface CapabilityProbeRawResult {
  readonly commandResults: Readonly<Record<OmpCommandName, CapabilityProbeCommandResult>>;
  readonly protocolVersion: 1 | 2;
}

export interface CapabilityProbeResult {
  readonly capabilities: CapabilityMap;
  readonly protocolVersion: 1 | 2;
  readonly evidence: readonly CapabilityProbeEvidenceResult[];
  readonly raw: CapabilityProbeRawResult;
}

/** True when any answer of the probe came from running out of time, so the probe cannot be trusted. */
export function probeRanOutOfTime(result: CapabilityProbeResult): boolean {
  return result.evidence.some(
    (entry) => entry.reason === PROBE_TIMEOUT_REASON || entry.reason === COMMAND_TIMEOUT_REASON,
  );
}

/** True when the whole probe ran out of time before it confirmed one thing (every answer is a timeout). */
export function probeTimedOutEntirely(result: CapabilityProbeResult): boolean {
  return (
    result.evidence.length > 0 &&
    result.evidence.every((entry) => entry.reason === PROBE_TIMEOUT_REASON)
  );
}

type CommandProbeResult = CapabilityProbeCommandResult;

function unavailable(detail: string): CapabilityStatus {
  return { state: "unavailable", via: "rpc", detail };
}

function available(via: "rpc" | "host"): CapabilityStatus {
  return { state: "available", via };
}

function commandCapability(command: OmpCommandName): `omp.cmd.${OmpCommandName}` {
  return `omp.cmd.${command}`;
}

function commandFailureReason(cause: unknown): string {
  if (cause instanceof AppFailure) {
    const error = cause.appError.omp?.error ?? cause.appError.message;
    if (error.startsWith("Unknown command:")) {
      return `${error} (${RPC_UNKNOWN_COMMAND_SOURCE})`;
    }
    if (cause.appError.code === "omp_error") {
      return `omp recognized the command but rejected the probe arguments (${RPC_INVALID_ARGUMENT_SOURCE})`;
    }
    return `probe failed with ${cause.appError.code}`;
  }
  return COMMAND_TIMEOUT_REASON;
}

function commandPayload(command: OmpCommandName): Record<string, unknown> {
  switch (command) {
    case "set_host_tools":
      return { tools: [] };
    case "set_host_uri_schemes":
      return { schemes: [] };
    case "set_subagent_subscription":
      return { level: "off" };
    case "set_event_filter":
      return { events: [], messageUpdates: "delta" };
    case "live_stop":
      return {};
    case "negotiate_protocol":
      return { protocolVersion: 2 };
    default:
      return {};
  }
}

async function probeCommand(
  session: RpcSession,
  command: OmpCommandName,
  timeoutMs: number,
): Promise<CommandProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const payload = {
      id: `capability-${command}`,
      type: command,
      ...commandPayload(command),
    } as OmpCommand;
    await session.send(payload, { signal: controller.signal });
    return { available: true };
  } catch (cause) {
    // Our own wait ran out: omp did not answer in time. That is a timeout, which the patient probe
    // asks again; the cancelled failure it raises would read as a verdict and never be retried.
    if (controller.signal.aborted) return { available: false, reason: COMMAND_TIMEOUT_REASON };
    return {
      available:
        cause instanceof AppFailure &&
        cause.appError.code === "omp_error" &&
        !(cause.appError.omp?.error ?? cause.appError.message).startsWith("Unknown command:"),
      reason: commandFailureReason(cause),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeGh(
  binary: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined) mergedEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) delete mergedEnv[key];
    else mergedEnv[key] = value;
  }
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([binary, "--version"], { env: mergedEnv, stdout: "pipe", stderr: "pipe" });
  } catch {
    return false;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the timeout and kill call.
    }
  }, timeoutMs);
  try {
    const [exitCode] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return !timedOut && exitCode === 0;
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("capability probe timed out")), timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function addCapability(
  map: Record<string, CapabilityStatus>,
  key: CapabilityKey,
  status: CapabilityStatus,
): void {
  map[key] = status;
}

/**
 * omp won't start without a default model, and a login lives in the user's own agent folder, which
 * the probe never reads (it runs in an empty home). A placeholder key lets it start for anyone; it
 * is never sent anywhere, because the probe sends no prompt.
 */
const PROBE_PLACEHOLDER_KEY = ["omp", "app", "capability", "probe"].join("-");
function addUnavailableUpstreamCapabilities(map: Record<string, CapabilityStatus>): void {
  addCapability(map, "upstream.mcp-reconnect", MCP_RECONNECT_UNAVAILABLE);
  for (const [key, detail] of Object.entries(D8_AP6_UNAVAILABLE_REASONS)) {
    addCapability(map, key as CapabilityKey, { state: "unavailable", via: "upstream", detail });
  }
}
export function capabilityProbeResultFromRaw(
  raw: CapabilityProbeRawResult,
  options: {
    readonly hostCapabilities?: readonly CapabilityKey[];
    readonly githubAvailable?: boolean;
  } = {},
): CapabilityProbeResult {
  const hostCapabilities = options.hostCapabilities ?? DEFAULT_HOST_CAPABILITIES;
  const capabilities: Record<string, CapabilityStatus> = {};
  const evidence: CapabilityProbeEvidenceResult[] = [];
  const timedOut = Object.values(raw.commandResults).some(
    (result) => result.reason === PROBE_TIMEOUT_REASON,
  );
  for (const command of OMP_COMMAND_NAMES) {
    const result = raw.commandResults[command];
    const unprobed = UNPROBED_COMMANDS.has(command);
    const reason = timedOut
      ? PROBE_TIMEOUT_REASON
      : result?.reason === PROBE_TIMEOUT_REASON || result?.reason === COMMAND_TIMEOUT_REASON
        ? result.reason
        : unprobed
          ? NOT_PROBED_REASON
          : (result?.reason ?? "command unavailable");
    addCapability(
      capabilities,
      commandCapability(command),
      unprobed || result?.available !== true ? unavailable(reason) : available("rpc"),
    );
    evidence.push({
      command,
      status: unprobed || result?.available !== true ? "unavailable" : "available",
      ...(reason === "command unavailable" ? {} : { reason }),
      source: COMMAND_PROBE_EVIDENCE[command].source,
    });
  }
  addCapability(
    capabilities,
    "omp.protocol.v2",
    timedOut
      ? unavailable(PROBE_TIMEOUT_REASON)
      : raw.protocolVersion === 2
        ? available("rpc")
        : unavailable("omp did not negotiate protocol v2 (omp-v18.12.6:docs/rpc.md:40-58)"),
  );
  addCapability(
    capabilities,
    "omp.ui",
    timedOut ? unavailable(PROBE_TIMEOUT_REASON) : available("rpc"),
  );
  const featureProbes: ReadonlyArray<readonly [CapabilityKey, OmpCommandName]> = [
    ["omp.host-tools", "set_host_tools"],
    ["omp.host-uris", "set_host_uri_schemes"],
    ["omp.subagent-events", "set_subagent_subscription"],
    ["omp.live-voice", "live_stop"],
  ];
  for (const [feature, command] of featureProbes) {
    const result = raw.commandResults[command];
    addCapability(
      capabilities,
      feature,
      timedOut
        ? unavailable(PROBE_TIMEOUT_REASON)
        : result?.available === true
          ? available("rpc")
          : unavailable(result?.reason ?? `the ${command} probe was unavailable`),
    );
  }
  for (const key of hostCapabilities) {
    if (key !== "host.github-refs") addCapability(capabilities, key, available("host"));
  }
  addCapability(
    capabilities,
    "host.github-refs",
    options.githubAvailable === true
      ? available("host")
      : {
          state: "fallback",
          via: "host",
          detail:
            "gh --version is unavailable; GitHub references use their explicit fallback path.",
        },
  );
  addUnavailableUpstreamCapabilities(capabilities);
  return {
    capabilities: CapabilityMap.parse(capabilities),
    protocolVersion: raw.protocolVersion,
    evidence,
    raw,
  };
}

export async function probeGithubRefs(
  options: {
    readonly ghBinary?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
  } = {},
): Promise<boolean> {
  return probeGh(options.ghBinary ?? "gh", options.env, options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS);
}

function isolatedProbeEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  probeCwd: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) environment[key] = value;
  }
  if (!environment.ANTHROPIC_API_KEY) environment.ANTHROPIC_API_KEY = PROBE_PLACEHOLDER_KEY;
  environment.HOME = join(probeCwd, "home");
  environment.PI_CODING_AGENT_DIR = join(probeCwd, "agent");
  environment.OMP_APP_DATA_DIR = join(probeCwd, "app-data");
  return environment;
}

function timedOutProbeResult(
  hostCapabilities: readonly CapabilityKey[],
  reason: string,
): CapabilityProbeResult {
  const commandResults = Object.fromEntries(
    OMP_COMMAND_NAMES.map((command) => [command, { available: false, reason }]),
  ) as Record<OmpCommandName, CapabilityProbeCommandResult>;
  return capabilityProbeResultFromRaw({ commandResults, protocolVersion: 1 }, { hostCapabilities });
}

/**
 * Starts one isolated chat process (the chat command), probes the command surface, then always closes it.
 * The result is safe to publish in both the welcome frame and AppPort; callers apply the negotiated
 * protocol version to a thread with `capabilitiesForProtocol`.
 */
export async function probeCapabilities(
  options: CapabilityProbeOptions,
): Promise<CapabilityProbeResult> {
  await mkdir(options.cwd, { recursive: true });
  const probeCwd = await mkdtemp(join(options.cwd, ".omp-capability-probe-"));
  const probeEnv = isolatedProbeEnvironment(options.env ?? {}, probeCwd);
  await Promise.all([
    mkdir(join(probeCwd, "home"), { recursive: true }),
    mkdir(join(probeCwd, "agent"), { recursive: true }),
    mkdir(join(probeCwd, "app-data"), { recursive: true }),
  ]);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadlineAt = Date.now() + (options.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS);
  const hostCapabilities = options.hostCapabilities ?? DEFAULT_HOST_CAPABILITIES;
  const threadId = ThreadId.parse(`capability-probe-${crypto.randomUUID()}`);
  const process = spawnOmpProcess({
    threadId,
    folder: FolderPath.parse(probeCwd),
    chatCommand: options.chatCommand,
    args: [...PROBE_OMP_ARGS],
    env: probeEnv,
    terminationGraceMs: Math.min(timeoutMs, 1_000),
  });
  const session = new RpcSession(process);
  const remainingMs = (): number => Math.max(1, deadlineAt - Date.now());
  try {
    try {
      await withTimeout(process.start(), Math.min(timeoutMs, remainingMs()));
      await withTimeout(session.start(), Math.min(timeoutMs, remainingMs()));
    } catch (cause) {
      if (
        Date.now() >= deadlineAt ||
        (cause instanceof Error && cause.message === "capability probe timed out")
      ) {
        return timedOutProbeResult(hostCapabilities, PROBE_TIMEOUT_REASON);
      }
      throw cause;
    }
    const commandResults = new Map<OmpCommandName, CommandProbeResult>();
    for (const command of OMP_COMMAND_NAMES) {
      if (UNPROBED_COMMANDS.has(command)) {
        commandResults.set(command, { available: false, reason: NOT_PROBED_REASON });
        continue;
      }
      if (Date.now() >= deadlineAt)
        return timedOutProbeResult(hostCapabilities, PROBE_TIMEOUT_REASON);
      const result = await probeCommand(session, command, Math.min(timeoutMs, remainingMs()));
      commandResults.set(command, result);
      if (Date.now() >= deadlineAt)
        return timedOutProbeResult(hostCapabilities, PROBE_TIMEOUT_REASON);
    }

    if (Date.now() >= deadlineAt)
      return timedOutProbeResult(hostCapabilities, PROBE_TIMEOUT_REASON);
    const ghAvailable = await probeGh(
      options.ghBinary ?? "gh",
      probeEnv,
      Math.min(DEFAULT_GH_TIMEOUT_MS, remainingMs()),
    );
    const raw = {
      commandResults: Object.fromEntries(commandResults.entries()) as Record<
        OmpCommandName,
        CapabilityProbeCommandResult
      >,
      protocolVersion: session.protocolVersion,
    } satisfies CapabilityProbeRawResult;
    return capabilityProbeResultFromRaw(raw, { hostCapabilities, githubAvailable: ghAvailable });
  } finally {
    await session.close();
    await rm(probeCwd, { recursive: true, force: true });
  }
}

export interface PatientProbeOptions extends CapabilityProbeOptions {
  /** What the one retry waits; the defaults are `PATIENT_PROBE_TIMEOUT_MS` and `PATIENT_PROBE_DEADLINE_MS`. */
  readonly patient?: { readonly timeoutMs: number; readonly deadlineMs: number };
  /** Called once, with how long the first attempt took, when it ran out of time and is retried. */
  readonly onRetry?: (waitedMs: number) => void;
}

/**
 * `probeCapabilities`, asked once more with longer waits when the first answer ran out of time.
 * Without it a slow start (a busy computer) would leave every omp feature unavailable until the
 * app is restarted.
 */
export async function probeCapabilitiesPatiently(
  options: PatientProbeOptions,
): Promise<CapabilityProbeResult> {
  const { patient, onRetry, ...probeOptions } = options;
  const started = performance.now();
  const first = await probeCapabilities(probeOptions);
  if (!probeRanOutOfTime(first)) return first;
  onRetry?.(Math.round(performance.now() - started));
  return probeCapabilities({
    ...probeOptions,
    timeoutMs: patient?.timeoutMs ?? PATIENT_PROBE_TIMEOUT_MS,
    deadlineMs: patient?.deadlineMs ?? PATIENT_PROBE_DEADLINE_MS,
  });
}

/** Applies a thread's negotiated protocol to an immutable copy of the server-wide map. */
export function capabilitiesForProtocol(
  serverCapabilities: CapabilityMap,
  protocolVersion: 1 | 2,
): CapabilityMap {
  return CapabilityMap.parse({
    ...serverCapabilities,
    "omp.protocol.v2":
      protocolVersion === 2
        ? available("rpc")
        : unavailable("this thread remained on RPC protocol v1 (omp-v18.12.6:docs/rpc.md:40-58)"),
  });
}
