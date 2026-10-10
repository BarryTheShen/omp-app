import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * The values omp reads from its environment for the Tools settings the app shows (omp v18.6.1).
 *
 * omp takes a variable from its process environment first, then from the `.env` files of the
 * project it runs in, the agent folder, the config folder and the home folder, in that order
 * (packages/utils/src/env.ts:287-303). A variable counts only when it is non-empty, so an empty one
 * falls through to the next source. A registered setting reads its variable before any settings
 * layer (packages/coding-agent/src/config/registry.ts:514-530); the browser and Auto QA code read
 * theirs directly. This module reads the same sources in the same order. The ConfigStore places
 * the result in its environment layer, which is where precedence against saved and default values
 * is decided.
 */

/** omp's flag texts (packages/utils/src/env.ts:472-487): these exact spellings are on, any other text is off. */
const ON_TEXTS: Readonly<Record<string, true>> = {
  "1": true,
  Y: true,
  y: true,
  TRUE: true,
  true: true,
  YES: true,
  yes: true,
  ON: true,
  on: true,
};

const OMP_ENVIRONMENT_SETTINGS = [
  // Registry `env` (packages/coding-agent/src/tools/settings.ts:961-965).
  { key: "dev.autoqa", variable: "PI_AUTO_QA", type: "boolean" },
  // Registry `env` (packages/coding-agent/src/tools/settings.ts:813-817).
  { key: "tools.intentTracing", variable: "PI_INTENT_TRACING", type: "boolean" },
  // Read directly, not through the registry: packages/coding-agent/src/tools/report-tool-issue.ts:365-370 and 385.
  { key: "dev.autoqaPush.endpoint", variable: "PI_AUTO_QA_PUSH_URL", type: "string" },
  // packages/coding-agent/src/tools/browser/relay/kind.ts:36.
  { key: "browser.relay", variable: "PI_BROWSER_RELAY", type: "boolean" },
  // packages/coding-agent/src/tools/browser/cmux/rpc.ts:187.
  { key: "browser.cmux", variable: "PI_BROWSER_CMUX", type: "boolean" },
  // packages/coding-agent/src/tools/browser/tern/kind.ts:33.
  { key: "browser.tern", variable: "PI_BROWSER_TERN", type: "boolean" },
] as const;

/** omp's variable-name rule (packages/utils/src/env.ts:9 and 16-18). */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Where omp finds the values for one read. */
export interface OmpEnvironmentSources {
  /** The environment omp's process starts with: the server's own environment, which every chat inherits. */
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  /** The user's home folder: it holds `~/.env` and the config folder (`~/.omp` unless `PI_CONFIG_DIR` says otherwise). */
  readonly homeDir: string;
  /** omp's agent folder, which the server passes to omp as `PI_CODING_AGENT_DIR`. */
  readonly agentDir: string;
  /** The folder omp runs in for this read, whose `.env` omp also reads, or null for a read with no project. */
  readonly projectDir: string | null;
}

function activeProfile(env: Readonly<Record<string, string | undefined>>): string | undefined {
  // OMP_PROFILE wins when it is set at all, even empty (packages/utils/src/dirs.ts:90-92).
  const raw = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const name = raw?.trim();
  return name && name !== "default" ? name : undefined;
}

// Mirrors omp's getBaseConfigRoot and getProfileConfigRoot (packages/utils/src/dirs.ts:115-122, 307-309).
function configRootDir(sources: OmpEnvironmentSources): string {
  const base = join(sources.homeDir, sources.processEnv.PI_CONFIG_DIR || ".omp");
  const profile = activeProfile(sources.processEnv);
  return profile ? join(base, "profiles", profile) : base;
}

/** The `.env` files omp reads for this read, highest precedence first (packages/utils/src/env.ts:300). */
function dotEnvPaths(sources: OmpEnvironmentSources): readonly string[] {
  const configRoot = configRootDir(sources);
  // With a profile, omp's agent folder is the profile's own (packages/utils/src/dirs.ts:347), not PI_CODING_AGENT_DIR.
  const agentDir = activeProfile(sources.processEnv) ? join(configRoot, "agent") : sources.agentDir;
  const project = sources.projectDir === null ? [] : [join(sources.projectDir, ".env")];
  return [
    ...project,
    join(agentDir, ".env"),
    join(configRoot, ".env"),
    join(sources.homeDir, ".env"),
  ];
}

/**
 * One `.env` file as omp parses it (packages/utils/src/env.ts:265-285): the file's valid variables,
 * with each `OMP_` name also set as its `PI_` name. A missing or unreadable file contributes nothing.
 */
async function readDotEnvFile(path: string): Promise<Readonly<Record<string, string>>> {
  let parsed: Readonly<Record<string, string | undefined>>;
  try {
    parsed = parseEnv(await readFile(path, "utf8"));
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && ENV_NAME_RE.test(key) && !value.includes("\0")) result[key] = value;
  }
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (key.startsWith("OMP_") && value !== undefined) result[`PI_${key.slice(4)}`] = value;
  }
  return result;
}

/** The first source that sets the variable to a non-empty text, as omp's loader chooses it (env.ts:300-303). */
function firstSetText(
  variable: string,
  sources: readonly Readonly<Record<string, string | undefined>>[],
): string | undefined {
  for (const source of sources) {
    const value = source[variable];
    if (value) return value;
  }
  return undefined;
}

/**
 * The environment values for the settings above, keyed by setting id, as omp would read them for
 * this read. A variable that no source sets is left out, so the saved or default value applies.
 */
export async function ompEnvironmentValues(
  sources: OmpEnvironmentSources,
): Promise<Readonly<Record<string, boolean | string>>> {
  const files: Readonly<Record<string, string>>[] = [];
  for (const path of dotEnvPaths(sources)) files.push(await readDotEnvFile(path));
  const layers = [sources.processEnv, ...files];
  const values: Record<string, boolean | string> = {};
  for (const setting of OMP_ENVIRONMENT_SETTINGS) {
    const raw = firstSetText(setting.variable, layers);
    if (raw === undefined) continue;
    if (setting.type === "boolean") {
      values[setting.key] = ON_TEXTS[raw] === true;
      continue;
    }
    const text = raw.trim();
    if (text !== "") values[setting.key] = text;
  }
  return values;
}
