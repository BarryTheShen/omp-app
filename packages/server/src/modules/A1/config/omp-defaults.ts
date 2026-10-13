import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  type ConfigStoreOptions,
  type ConfigStoreService,
  createConfigStore,
} from "./config-store";

const DEFAULTS_TIMEOUT_MS = 5_000;
/** A patient attempt waits this long: a busy computer can need longer than a quiet one (the omp probe waits 20 s). */
const PATIENT_DEFAULTS_TIMEOUT_MS = 20_000;
/** Patient attempts stop this long after the first run ran out of time. */
const PATIENT_DEFAULTS_DEADLINE_MS = 60_000;
const LEFTOVER_FOLDER_WARNING =
  "omp setting defaults loaded, but their temporary folder could not be removed.";

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
const ConfigListSchema = z.record(z.string(), z.object({ value: JsonValueSchema.optional() }));

export interface OmpDefaultsProbeOptions {
  readonly binary: string;
  readonly launchDirectory: string;
  readonly pathEnvironment: string;
  readonly timeoutMs?: number;
  /** Test-only: how long each patient attempt waits, and how long the retries may run, after a timeout. */
  readonly patientTimeoutMs?: number;
  readonly patientDeadlineMs?: number;
  /** Test-only parent for the short-lived isolated config root. */
  readonly temporaryDirectoryBase?: string;
  readonly onWarning?: (message: string) => void;
}

/**
 * The defaults, or the reason they could not be loaded (a few words, no output from omp). `timedOut` means omp
 * ran out of time, so asking again may get an answer.
 */
type Loaded =
  | { readonly defaults: Readonly<Record<string, unknown>> }
  | { readonly cause: string; readonly timedOut?: boolean };

interface LoadResult {
  readonly loaded: Loaded;
  /** The temporary folder could not be removed; the defaults are unaffected. */
  readonly leftover: boolean;
}

function defaultsWarning(cause: string): string {
  return `omp setting defaults could not be loaded (${cause}); continuing without registered defaults.`;
}

/** Creates the server's ConfigStore with omp's registered defaults when available. */
export async function createConfigStoreWithOmpDefaults(
  options: Omit<ConfigStoreOptions, "defaultValues">,
  probe: OmpDefaultsProbeOptions,
): Promise<ConfigStoreService> {
  const first = await loadOmpDefaults(probe);
  const store = createConfigStore({
    ...options,
    ...("defaults" in first.loaded ? { defaultValues: first.loaded.defaults } : {}),
  });
  const leftover = first.leftover ? [LEFTOVER_FOLDER_WARNING] : [];
  if ("defaults" in first.loaded) {
    reportWarnings(probe, leftover);
  } else if (first.loaded.timedOut) {
    const waiting = `omp setting defaults could not be loaded (${first.loaded.cause}); trying again in the background.`;
    reportWarnings(probe, [waiting, ...leftover]);
    retryPatiently(store, probe, first.loaded.cause).catch((error: unknown) =>
      reportWarnings(probe, [
        defaultsWarning(error instanceof Error ? error.message : String(error)),
      ]),
    );
  } else {
    reportWarnings(probe, [defaultsWarning(first.loaded.cause), ...leftover]);
  }
  return store;
}

/**
 * Asks omp again, patiently, after a first run ran out of time. The server is already listening: the defaults
 * reach the store when omp answers, and the store tells open settings panels about them.
 */
async function retryPatiently(
  store: ConfigStoreService,
  probe: OmpDefaultsProbeOptions,
  firstCause: string,
): Promise<void> {
  const deadline = Date.now() + (probe.patientDeadlineMs ?? PATIENT_DEFAULTS_DEADLINE_MS);
  let cause = firstCause;
  while (!store.disposeSignal.aborted && Date.now() < deadline) {
    const timeoutMs = Math.min(
      probe.patientTimeoutMs ?? PATIENT_DEFAULTS_TIMEOUT_MS,
      deadline - Date.now(),
    );
    const attempt = await loadOmpDefaults({ ...probe, timeoutMs }, store.disposeSignal);
    if (store.disposeSignal.aborted) return;
    if (attempt.leftover) reportWarnings(probe, [LEFTOVER_FOLDER_WARNING]);
    if ("defaults" in attempt.loaded) {
      await store.setDefaults(attempt.loaded.defaults);
      return;
    }
    cause = attempt.loaded.cause;
    if (!attempt.loaded.timedOut) break;
  }
  if (!store.disposeSignal.aborted) reportWarnings(probe, [defaultsWarning(cause)]);
}

function reportWarnings(probe: OmpDefaultsProbeOptions, messages: readonly string[]): void {
  for (const message of messages) {
    if (probe.onWarning) probe.onWarning(message);
    else console.warn(message);
  }
}

async function loadOmpDefaults(
  options: OmpDefaultsProbeOptions,
  signal?: AbortSignal,
): Promise<LoadResult> {
  let temporaryRoot: string | undefined;
  let loaded: Loaded;
  try {
    temporaryRoot = await mkdtemp(
      join(options.temporaryDirectoryBase ?? tmpdir(), "omp-app-config-defaults-"),
    );
    const home = join(temporaryRoot, "home");
    const agent = join(temporaryRoot, "agent");
    const temp = join(temporaryRoot, "tmp");
    await Promise.all([
      mkdir(join(home, ".omp"), { recursive: true }),
      mkdir(agent, { recursive: true }),
      mkdir(temp, { recursive: true }),
    ]);
    loaded = await runConfigList(options, temporaryRoot, home, agent, temp, signal);
  } catch {
    loaded = { cause: "the temporary config folder could not be created" };
  }
  let leftover = false;
  if (temporaryRoot !== undefined) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch {
      leftover = true;
    }
  }
  return { loaded, leftover };
}

async function runConfigList(
  options: OmpDefaultsProbeOptions,
  temporaryRoot: string,
  home: string,
  agent: string,
  temp: string,
  signal?: AbortSignal,
): Promise<Loaded> {
  const binary = resolveBinary(options.binary, options.launchDirectory);
  const env = {
    PATH: options.pathEnvironment,
    HOME: home,
    PI_CONFIG_DIR: ".omp",
    PI_CODING_AGENT_DIR: agent,
    TMPDIR: temp,
  };
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([binary, "config", "list", "--json"], {
      cwd: temporaryRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
      // Its own process group, so that a wrapper's children can be stopped with it.
      detached: true,
    });
  } catch {
    return { cause: "omp could not be started" };
  }

  // Disposing the store stops a retry still waiting for omp, and the process group with it.
  const stop = () => stopProcessGroup(child);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();

  const timeoutMs = normalizeTimeout(options.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  // A wrapper's child can keep the output pipes open after omp is stopped, so the wait for the output
  // is bounded by the deadline too, not only by the pipes closing.
  const finished = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(
    ([exitCode, stdout]) => ({ exitCode, stdout }),
    () => undefined,
  );
  try {
    const outcome = await Promise.race([finished, deadline]);
    if (outcome === "timeout") {
      return { cause: `omp timed out after ${timeoutMs} ms`, timedOut: true };
    }
    if (outcome === undefined) return { cause: "omp's output could not be read" };
    if (outcome.exitCode !== 0) return { cause: `omp exited with code ${outcome.exitCode}` };
    return parseDefaults(outcome.stdout);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    stopProcessGroup(child);
  }
}

/** Stops omp and whatever it started. A group that has already gone is not an error. */
function stopProcessGroup(child: Bun.Subprocess<"pipe", "pipe", "pipe">): void {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group has already exited.
  }
}

function parseDefaults(output: string): Loaded {
  let input: unknown;
  try {
    input = JSON.parse(output);
  } catch {
    return { cause: "omp's output was not valid JSON" };
  }
  const parsed = ConfigListSchema.safeParse(input);
  if (!parsed.success) return { cause: "omp's output had an unexpected shape" };

  const entries: [string, unknown][] = [];
  for (const [key, setting] of Object.entries(parsed.data)) {
    if (setting.value !== undefined) entries.push([key, setting.value]);
  }
  return entries.length === 0
    ? { cause: "omp listed no settings" }
    : { defaults: Object.fromEntries(entries) };
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULTS_TIMEOUT_MS;
  return Math.max(1, Math.floor(timeoutMs));
}

function resolveBinary(binary: string, launchDirectory: string): string {
  if (isAbsolute(binary) || (!binary.includes("/") && !binary.includes("\\"))) return binary;
  return resolve(launchDirectory, binary);
}
