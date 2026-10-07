import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AppFailure,
  type CapabilityKey,
  CapabilityMap,
  type CapabilityStatus,
  FolderPath,
  OMP_COMMAND_NAMES,
  type OmpCommand,
  type OmpCommandName,
  ThreadId,
} from "@omp-app/contracts";
import { RpcSession } from "@omp-app/omp-rpc";
import { type OmpProcess, type OmpProcessOptions, spawnOmpProcess } from "../process";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_GH_TIMEOUT_MS = 2_000;
const DEFAULT_PROBE_DEADLINE_MS = 15_000;
const PROBE_TIMEOUT_REASON =
  "omp capability probe timed out before all capabilities were confirmed";
const PROBE_OMP_ARGS = [
  "--no-session",
  "--no-title",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
] as const;
export const RPC_NO_SESSION_SOURCE =
  "omp-v18.6.1:packages/coding-agent/src/cli/flag-tables.ts:307-310; cli/args.ts:316-319";

/** The source of the generic unknown-command branch used by all command probes. */
export const RPC_UNKNOWN_COMMAND_SOURCE =
  "omp-v18.6.1:packages/coding-agent/src/modes/rpc/rpc-mode.ts:2419-2422";
/** The source of the response/error contract used to classify invalid arguments. */
export const RPC_INVALID_ARGUMENT_SOURCE =
  "omp-v18.6.1:packages/coding-agent/src/modes/rpc/rpc-mode.ts:1760-1765,2400-2402; docs/rpc.md:114-119,283-290";

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
  "host.memory-store",
  "host.plan-documents",
  "host.provider-accounts",
  "host.rules",
  "host.session-files",
  "host.session-import",
  "host.session-pins",
  "host.url-catalog",
  "host.workspace-state",
] as const satisfies readonly CapabilityKey[];

export type CommandProbeKind = "read-only" | "invalid-arguments";

export interface CommandProbeEvidence {
  readonly kind: CommandProbeKind;
  /** The command's canonical schema documentation, plus the dispatcher/error sources. */
  readonly source: string;
}

const COMMAND_DOCUMENTATION_SOURCE: Readonly<Record<OmpCommandName, string>> = {
  negotiate_protocol: "omp-v18.6.1:docs/rpc.md:137-140",
  prompt: "omp-v18.6.1:docs/rpc.md:125-135",
  steer: "omp-v18.6.1:docs/rpc.md:125-135",
  follow_up: "omp-v18.6.1:docs/rpc.md:125-135",
  remove_queued_message: "omp-v18.6.1:docs/rpc.md:125-135",
  promote_queued_message: "omp-v18.6.1:docs/rpc.md:125-135",
  abort: "omp-v18.6.1:docs/rpc.md:125-135",
  abort_and_prompt: "omp-v18.6.1:docs/rpc.md:125-135",
  new_session: "omp-v18.6.1:docs/rpc.md:125-135",
  open_session: "omp-v18.6.1:docs/rpc.md:125-135",
  get_state: "omp-v18.6.1:docs/rpc.md:141-149",
  set_fast_mode: "omp-v18.6.1:docs/rpc.md:141-149",
  goal: "omp-v18.6.1:docs/rpc.md:141-149",
  set_ask_dialog: "omp-v18.6.1:docs/rpc.md:141-149",
  get_available_commands: "omp-v18.6.1:docs/rpc.md:141-149",
  get_entries: "omp-v18.6.1:docs/rpc.md:141-149",
  get_tree: "omp-v18.6.1:docs/rpc.md:141-149",
  set_todos: "omp-v18.6.1:docs/rpc.md:141-149",
  set_host_tools: "omp-v18.6.1:docs/rpc.md:141-149",
  set_host_uri_schemes: "omp-v18.6.1:docs/rpc.md:141-149",
  set_subagent_subscription: "omp-v18.6.1:docs/rpc.md:141-149",
  set_event_filter: "omp-v18.6.1:docs/rpc.md:141-149",
  get_subagents: "omp-v18.6.1:docs/rpc.md:141-149",
  get_subagent_messages: "omp-v18.6.1:docs/rpc.md:141-149",
  cancel_subagent: "omp-v18.6.1:docs/rpc.md:141-149",
  steer_subagent: "omp-v18.6.1:docs/rpc.md:141-149",
  live_start: "omp-v18.6.1:packages/coding-agent/src/modes/rpc/rpc-types.ts:71-73",
  live_stop: "omp-v18.6.1:packages/coding-agent/src/modes/rpc/rpc-types.ts:71-73",
  live_mute: "omp-v18.6.1:packages/coding-agent/src/modes/rpc/rpc-types.ts:71-73",
  set_model: "omp-v18.6.1:docs/rpc.md:160-166",
  cycle_model: "omp-v18.6.1:docs/rpc.md:160-166",
  get_available_models: "omp-v18.6.1:docs/rpc.md:160-166",
  set_thinking_level: "omp-v18.6.1:docs/rpc.md:168-174",
  cycle_thinking_level: "omp-v18.6.1:docs/rpc.md:168-174",
  get_available_thinking_levels: "omp-v18.6.1:docs/rpc.md:168-174",
  set_steering_mode: "omp-v18.6.1:docs/rpc.md:176-180",
  set_follow_up_mode: "omp-v18.6.1:docs/rpc.md:176-180",
  set_interrupt_mode: "omp-v18.6.1:docs/rpc.md:176-180",
  compact: "omp-v18.6.1:docs/rpc.md:182-185",
  set_auto_compaction: "omp-v18.6.1:docs/rpc.md:182-185",
  set_cache_warming: "omp-v18.6.1:docs/rpc.md:187-202",
  set_auto_retry: "omp-v18.6.1:docs/rpc.md:204-207",
  abort_retry: "omp-v18.6.1:docs/rpc.md:204-207",
  bash: "omp-v18.6.1:docs/rpc.md:209-219",
  abort_bash: "omp-v18.6.1:docs/rpc.md:209-219",
  get_session_stats: "omp-v18.6.1:docs/rpc.md:221-233",
  export_html: "omp-v18.6.1:docs/rpc.md:221-233",
  switch_session: "omp-v18.6.1:docs/rpc.md:221-233",
  branch: "omp-v18.6.1:docs/rpc.md:221-233",
  fork: "omp-v18.6.1:docs/rpc.md:221-233",
  get_branch_messages: "omp-v18.6.1:docs/rpc.md:221-233",
  get_last_assistant_text: "omp-v18.6.1:docs/rpc.md:221-233",
  set_session_name: "omp-v18.6.1:docs/rpc.md:221-233",
  handoff: "omp-v18.6.1:docs/rpc.md:221-233",
  get_messages: "omp-v18.6.1:docs/rpc.md:237-244",
  get_messages_page: "omp-v18.6.1:docs/rpc.md:237-244",
  get_login_providers: "omp-v18.6.1:docs/rpc.md:246-254",
  login: "omp-v18.6.1:docs/rpc.md:246-254",
  predict_word: "omp-v18.6.1:docs/rpc.md:256-281",
  predict_word_feedback: "omp-v18.6.1:docs/rpc.md:256-281",
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
  readonly ompBin?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Maximum time allowed for an individual omp command. */
  readonly timeoutMs?: number;
  /** Maximum time allowed for startup and the complete command loop. */
  readonly deadlineMs?: number;
  readonly ghBinary?: string;
  readonly hostCapabilities?: readonly CapabilityKey[];
  readonly createProcess?: (options: OmpProcessOptions) => OmpProcess;
}

export interface CapabilityProbeEvidenceResult {
  readonly command: OmpCommandName;
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly source: string;
}

export interface CapabilityProbeResult {
  readonly capabilities: CapabilityMap;
  readonly protocolVersion: 1 | 2;
  readonly evidence: readonly CapabilityProbeEvidenceResult[];
}

interface CommandProbeResult {
  readonly available: boolean;
  readonly reason?: string;
}

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
  return "omp did not return a command response before the probe timed out";
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
  const capabilities: Record<string, CapabilityStatus> = {};
  const evidence = OMP_COMMAND_NAMES.map((command) => ({
    command,
    status: "unavailable" as const,
    reason,
    source: COMMAND_PROBE_EVIDENCE[command].source,
  }));
  for (const command of OMP_COMMAND_NAMES) {
    addCapability(capabilities, commandCapability(command), unavailable(reason));
  }
  for (const feature of [
    "omp.protocol.v2",
    "omp.ui",
    "omp.host-tools",
    "omp.host-uris",
    "omp.subagent-events",
    "omp.live-voice",
  ] as const) {
    addCapability(capabilities, feature, unavailable(reason));
  }
  for (const key of hostCapabilities) {
    addCapability(
      capabilities,
      key,
      key === "host.github-refs"
        ? { state: "fallback", via: "host", detail: "gh probe skipped because omp probe timed out" }
        : available("host"),
    );
  }
  return { capabilities: CapabilityMap.parse(capabilities), protocolVersion: 1, evidence };
}

/**
 * Starts one isolated `omp --mode rpc-ui` process, probes the command surface, then always closes it.
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
  const createProcess = options.createProcess ?? spawnOmpProcess;
  const threadId = ThreadId.parse(`capability-probe-${crypto.randomUUID()}`);
  const process = createProcess({
    threadId,
    folder: FolderPath.parse(probeCwd),
    ompBin: options.ompBin,
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
    const evidence: CapabilityProbeEvidenceResult[] = [];
    for (const command of OMP_COMMAND_NAMES) {
      if (Date.now() >= deadlineAt)
        return timedOutProbeResult(hostCapabilities, PROBE_TIMEOUT_REASON);
      const result = await probeCommand(session, command, Math.min(timeoutMs, remainingMs()));
      commandResults.set(command, result);
      evidence.push({
        command,
        status: result.available ? "available" : "unavailable",
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        source: COMMAND_PROBE_EVIDENCE[command].source,
      });
      if (Date.now() >= deadlineAt)
        return timedOutProbeResult(hostCapabilities, PROBE_TIMEOUT_REASON);
    }

    const capabilities: Record<string, CapabilityStatus> = {};
    for (const command of OMP_COMMAND_NAMES) {
      const result = commandResults.get(command);
      if (result?.available === true)
        addCapability(capabilities, commandCapability(command), available("rpc"));
      else
        addCapability(
          capabilities,
          commandCapability(command),
          unavailable(result?.reason ?? "command unavailable"),
        );
    }
    addCapability(
      capabilities,
      "omp.protocol.v2",
      session.protocolVersion === 2
        ? available("rpc")
        : unavailable("omp did not negotiate protocol v2 (omp-v18.6.1:docs/rpc.md:40-58)"),
    );
    addCapability(capabilities, "omp.ui", available("rpc"));

    const featureProbes: ReadonlyArray<readonly [CapabilityKey, OmpCommandName]> = [
      ["omp.host-tools", "set_host_tools"],
      ["omp.host-uris", "set_host_uri_schemes"],
      ["omp.subagent-events", "set_subagent_subscription"],
      ["omp.live-voice", "live_stop"],
    ];
    for (const [feature, command] of featureProbes) {
      const result = commandResults.get(command);
      addCapability(
        capabilities,
        feature,
        result?.available === true
          ? available("rpc")
          : unavailable(result?.reason ?? `the ${command} probe was unavailable`),
      );
    }

    for (const key of hostCapabilities) {
      if (key === "host.github-refs") continue;
      addCapability(capabilities, key, available("host"));
    }
    if (Date.now() >= deadlineAt)
      return timedOutProbeResult(hostCapabilities, PROBE_TIMEOUT_REASON);
    const ghAvailable = await probeGh(
      options.ghBinary ?? "gh",
      probeEnv,
      Math.min(DEFAULT_GH_TIMEOUT_MS, remainingMs()),
    );
    addCapability(
      capabilities,
      "host.github-refs",
      ghAvailable
        ? available("host")
        : {
            state: "fallback",
            via: "host",
            detail:
              "gh --version is unavailable; GitHub references use their explicit fallback path.",
          },
    );
    return {
      capabilities: CapabilityMap.parse(capabilities),
      protocolVersion: session.protocolVersion,
      evidence,
    };
  } finally {
    await session.close();
    await rm(probeCwd, { recursive: true, force: true });
  }
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
        : unavailable("this thread remained on RPC protocol v1 (omp-v18.6.1:docs/rpc.md:40-58)"),
  });
}
