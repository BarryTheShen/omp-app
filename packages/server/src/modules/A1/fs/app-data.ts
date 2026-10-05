import { chmodSync, promises as fs, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { cleanupAtomicTempFiles, cleanupAtomicTempFilesSync } from "./atomic-file";

export const APP_DATA_DIR_ENV = "OMP_APP_DATA_DIR";
export const DEFAULT_APP_DATA_RELATIVE_PATH = [".omp", "app"] as const;

export interface AppDataDirectoryOptions {
  /** Environment values to inspect. Defaults to the current process environment. */
  env?: Record<string, string | undefined>;
  /** Home directory used when the environment does not select a path. */
  homeDir?: string;
  /** Base directory for a relative OMP_APP_DATA_DIR value. */
  cwd?: string;
}

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homeDirectory, value.slice(2));
  }
  return value;
}

function configuredValue(options: AppDataDirectoryOptions): string | undefined {
  const environment = options.env ?? process.env;
  const value = environment[APP_DATA_DIR_ENV];
  return value && value.trim().length > 0 ? value : undefined;
}

/** Resolves OMP_APP_DATA_DIR, defaulting to ~/.omp/app without touching the filesystem. */
export function resolveAppDataDir(options: AppDataDirectoryOptions = {}): string {
  const homeDirectory = options.homeDir ?? homedir();
  const value = configuredValue(options);
  const selected = value
    ? expandHome(value, homeDirectory)
    : join(homeDirectory, ...DEFAULT_APP_DATA_RELATIVE_PATH);
  const base = options.cwd ?? process.cwd();
  return resolve(isAbsolute(selected) ? selected : join(base, selected));
}

function pathFromInput(input?: string | AppDataDirectoryOptions): string {
  if (typeof input === "string") {
    const homeDirectory = homedir();
    const expanded = expandHome(input, homeDirectory);
    return resolve(isAbsolute(expanded) ? expanded : join(process.cwd(), expanded));
  }
  return resolveAppDataDir(input);
}

/**
 * Ensures the app-owned data root exists with private permissions and removes
 * orphaned atomic-write files left by an interrupted process.
 */
export async function ensureAppDataDir(input?: string | AppDataDirectoryOptions): Promise<string> {
  const directory = pathFromInput(input);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await cleanupAtomicTempFiles(directory);
  return directory;
}

/** Synchronous startup variant for server bootstrap code that initializes before listening. */
export function ensureAppDataDirSync(input?: string | AppDataDirectoryOptions): string {
  const directory = pathFromInput(input);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  cleanupAtomicTempFilesSync(directory);
  return directory;
}
