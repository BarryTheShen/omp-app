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
const DEFAULTS_WARNING =
  "omp setting defaults could not be loaded; continuing without registered defaults.";

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

/** Creates the server's ConfigStore with omp's registered defaults when available. */
export async function createConfigStoreWithOmpDefaults(
  options: Omit<ConfigStoreOptions, "defaultValues">,
  probe: OmpDefaultsProbeOptions,
): Promise<ConfigStoreService> {
  const defaultValues = await loadOmpDefaults(probe);
  if (defaultValues === undefined) {
    if (probe.onWarning) probe.onWarning(DEFAULTS_WARNING);
    else console.warn(DEFAULTS_WARNING);
  }
  return createConfigStore({
    ...options,
    ...(defaultValues === undefined ? {} : { defaultValues }),
  });
}

async function loadOmpDefaults(
  options: OmpDefaultsProbeOptions,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  let temporaryRoot: string | undefined;
  let defaultValues: Readonly<Record<string, unknown>> | undefined;
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

    const output = await runConfigList(options, temporaryRoot, home, agent, temp);
    if (output !== undefined) defaultValues = parseDefaults(output);
  } catch {
    defaultValues = undefined;
  }
  if (temporaryRoot !== undefined) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true });
    } catch {
      defaultValues = undefined;
    }
  }
  return defaultValues;
}

async function runConfigList(
  options: OmpDefaultsProbeOptions,
  temporaryRoot: string,
  home: string,
  agent: string,
  temp: string,
): Promise<string | undefined> {
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
    });
  } catch {
    return undefined;
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited just before the timeout.
    }
  }, normalizeTimeout(options.timeoutMs));
  try {
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return timedOut || exitCode !== 0 ? undefined : stdout;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    try {
      child.kill("SIGKILL");
    } catch {
      // The process has already exited.
    }
  }
}

function parseDefaults(output: string): Readonly<Record<string, unknown>> | undefined {
  let input: unknown;
  try {
    input = JSON.parse(output);
  } catch {
    return undefined;
  }
  const parsed = ConfigListSchema.safeParse(input);
  if (!parsed.success) return undefined;

  const entries: [string, unknown][] = [];
  for (const [key, setting] of Object.entries(parsed.data)) {
    if (setting.value !== undefined) entries.push([key, setting.value]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULTS_TIMEOUT_MS;
  return Math.max(1, Math.floor(timeoutMs));
}

function resolveBinary(binary: string, launchDirectory: string): string {
  if (isAbsolute(binary) || (!binary.includes("/") && !binary.includes("\\"))) return binary;
  return resolve(launchDirectory, binary);
}
