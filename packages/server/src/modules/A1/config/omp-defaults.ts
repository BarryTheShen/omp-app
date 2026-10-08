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
  /** Test-only parent for the short-lived isolated config root. */
  readonly temporaryDirectoryBase?: string;
  readonly onWarning?: (message: string) => void;
}

/** The defaults, or the reason they could not be loaded (a few words, no output from omp). */
type Loaded = { readonly defaults: Readonly<Record<string, unknown>> } | { readonly cause: string };

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
  const { loaded, leftover } = await loadOmpDefaults(probe);
  const messages: string[] = [];
  if (!("defaults" in loaded)) messages.push(defaultsWarning(loaded.cause));
  if (leftover) messages.push(LEFTOVER_FOLDER_WARNING);
  for (const message of messages) {
    if (probe.onWarning) probe.onWarning(message);
    else console.warn(message);
  }
  return createConfigStore({
    ...options,
    ...("defaults" in loaded ? { defaultValues: loaded.defaults } : {}),
  });
}

async function loadOmpDefaults(options: OmpDefaultsProbeOptions): Promise<LoadResult> {
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
    loaded = await runConfigList(options, temporaryRoot, home, agent, temp);
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
    if (outcome === "timeout") return { cause: `omp timed out after ${timeoutMs} ms` };
    if (outcome === undefined) return { cause: "omp's output could not be read" };
    if (outcome.exitCode !== 0) return { cause: `omp exited with code ${outcome.exitCode}` };
    return parseDefaults(outcome.stdout);
  } finally {
    clearTimeout(timer);
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
