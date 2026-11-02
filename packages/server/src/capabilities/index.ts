import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type CapabilityKey,
  CapabilityMap,
  type CapabilityStatus,
  D8_AP6_UNAVAILABLE_REASONS,
  FolderPath,
  ompCommandCapability,
  ThreadId,
} from "@omp-app/contracts";
import {
  CHAT_HOST_METHODS,
  type ChatHostHello,
  type ChatHostMethod,
} from "@omp-app/contracts/chat-host";
import { ChatHostClient } from "../chat-host/client";
import { spawnOmpProcess } from "../process";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_GH_TIMEOUT_MS = 2_000;
const DEFAULT_PROBE_DEADLINE_MS = 15_000;
/** What a probe that ran out of time is retried with: a busy computer needs longer than a quiet one. */
export const PATIENT_PROBE_TIMEOUT_MS = 20_000;
export const PATIENT_PROBE_DEADLINE_MS = 60_000;
const PROBE_TIMEOUT_REASON =
  "omp capability probe timed out before all capabilities were confirmed";
/** omp's own launch flags, which the chat host reads as omp does: no session file, no title, nothing loaded. */
const PROBE_OMP_ARGS = [
  "--no-session",
  "--no-title",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
] as const;

/** Where every command's answer comes from: the chat host's first line lists the methods it answers. */
export const HELLO_SOURCE =
  "the chat host's hello (packages/contracts/src/chat-host/protocol.ts, ChatHostHello.methods)";

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
  "host.model-preferences",
  "host.plan-documents",
  "host.provider-accounts",
  "host.rules",
  "host.session-files",
  "host.session-import",
  "host.session-pins",
  "host.url-catalog",
  "host.usage-limits",
  "host.workspace-files",
  "host.workspace-state",
] as const satisfies readonly CapabilityKey[];

export interface CapabilityProbeOptions {
  /** The isolated cwd for the short-lived probe process, normally a directory under app data. */
  readonly cwd: FolderPath;
  /** The command that starts a chat host (`chatHostCommand()` in `omp-host/chat-command.ts`), or a test's stand-in. */
  readonly chatCommand: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Maximum time allowed for the chat host to start and say hello. */
  readonly timeoutMs?: number;
  /** Maximum time allowed for the whole check, the gh check included. */
  readonly deadlineMs?: number;
  readonly ghBinary?: string;
  readonly hostCapabilities?: readonly CapabilityKey[];
}

export interface CapabilityProbeEvidenceResult {
  readonly command: ChatHostMethod;
  readonly status: "available" | "unavailable";
  readonly reason?: string;
  readonly source: string;
}

export interface CapabilityProbeCommandResult {
  readonly available: boolean;
  readonly reason?: string;
}

/** What the check found, as the probe cache keeps it. */
export interface CapabilityProbeRawResult {
  readonly commandResults: Readonly<Record<ChatHostMethod, CapabilityProbeCommandResult>>;
}

export interface CapabilityProbeResult {
  readonly capabilities: CapabilityMap;
  readonly evidence: readonly CapabilityProbeEvidenceResult[];
  readonly raw: CapabilityProbeRawResult;
}

/** True when the chat host did not say hello in time, so the check confirmed nothing and cannot be trusted. */
export function probeTimedOut(result: CapabilityProbeResult): boolean {
  return result.evidence.some((entry) => entry.reason === PROBE_TIMEOUT_REASON);
}

function unavailable(detail: string): CapabilityStatus {
  return { state: "unavailable", via: "omp", detail };
}

function available(via: "omp" | "host"): CapabilityStatus {
  return { state: "available", via };
}

function notAnswered(command: ChatHostMethod): string {
  return `the chat host does not answer ${command}`;
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
  for (const command of CHAT_HOST_METHODS) {
    const result = raw.commandResults[command];
    const answered = !timedOut && result?.available === true;
    const reason = timedOut ? PROBE_TIMEOUT_REASON : (result?.reason ?? notAnswered(command));
    addCapability(
      capabilities,
      ompCommandCapability(command),
      answered ? available("omp") : unavailable(reason),
    );
    evidence.push({
      command,
      status: answered ? "available" : "unavailable",
      ...(answered ? {} : { reason }),
      source: HELLO_SOURCE,
    });
  }
  // The chat host hands omp's dialogs and UI events to the app as its `ui.*` requests and `ui_*` events.
  addCapability(
    capabilities,
    "omp.ui",
    timedOut ? unavailable(PROBE_TIMEOUT_REASON) : available("omp"),
  );
  const features: ReadonlyArray<readonly [CapabilityKey, ChatHostMethod]> = [
    ["omp.host-tools", "set_host_tools"],
    ["omp.host-uris", "set_host_uri_schemes"],
    ["omp.subagent-events", "set_subagent_subscription"],
    ["omp.live-voice", "live_stop"],
  ];
  for (const [feature, command] of features) {
    const result = raw.commandResults[command];
    addCapability(
      capabilities,
      feature,
      timedOut
        ? unavailable(PROBE_TIMEOUT_REASON)
        : result?.available === true
          ? available("omp")
          : unavailable(result?.reason ?? notAnswered(command)),
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

function timedOutProbeResult(hostCapabilities: readonly CapabilityKey[]): CapabilityProbeResult {
  const commandResults = Object.fromEntries(
    CHAT_HOST_METHODS.map((command) => [
      command,
      { available: false, reason: PROBE_TIMEOUT_REASON },
    ]),
  ) as Record<ChatHostMethod, CapabilityProbeCommandResult>;
  return capabilityProbeResultFromRaw({ commandResults }, { hostCapabilities });
}

/** What a chat host's hello says about each of its methods: answered when the hello lists it. */
function commandResultsOf(
  hello: ChatHostHello,
): Record<ChatHostMethod, CapabilityProbeCommandResult> {
  const methods = new Set(hello.methods);
  return Object.fromEntries(
    CHAT_HOST_METHODS.map((command) => [
      command,
      methods.has(command)
        ? { available: true }
        : { available: false, reason: notAnswered(command) },
    ]),
  ) as Record<ChatHostMethod, CapabilityProbeCommandResult>;
}

/**
 * Starts one isolated chat host, the program the chats run, reads the methods its hello lists, then always stops it.
 * A method the hello leaves out reads as unavailable. The result is safe to publish in both the welcome frame and AppPort.
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
  const hostProcess = spawnOmpProcess({
    threadId,
    folder: FolderPath.parse(probeCwd),
    chatCommand: options.chatCommand,
    args: [...PROBE_OMP_ARGS],
    env: probeEnv,
    terminationGraceMs: Math.min(timeoutMs, 1_000),
  });
  const client = new ChatHostClient(hostProcess);
  const remainingMs = (): number => Math.max(1, deadlineAt - Date.now());
  try {
    let hello: ChatHostHello;
    try {
      await withTimeout(hostProcess.start(), Math.min(timeoutMs, remainingMs()));
      hello = await withTimeout(client.hello, Math.min(timeoutMs, remainingMs()));
    } catch (cause) {
      if (
        Date.now() >= deadlineAt ||
        (cause instanceof Error && cause.message === "capability probe timed out")
      ) {
        return timedOutProbeResult(hostCapabilities);
      }
      throw cause;
    }
    const ghAvailable = await probeGh(
      options.ghBinary ?? "gh",
      probeEnv,
      Math.min(DEFAULT_GH_TIMEOUT_MS, remainingMs()),
    );
    return capabilityProbeResultFromRaw(
      { commandResults: commandResultsOf(hello) },
      { hostCapabilities, githubAvailable: ghAvailable },
    );
  } finally {
    client.dispose();
    await hostProcess.stop();
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
  if (!probeTimedOut(first)) return first;
  onRetry?.(Math.round(performance.now() - started));
  return probeCapabilities({
    ...probeOptions,
    timeoutMs: patient?.timeoutMs ?? PATIENT_PROBE_TIMEOUT_MS,
    deadlineMs: patient?.deadlineMs ?? PATIENT_PROBE_DEADLINE_MS,
  });
}
