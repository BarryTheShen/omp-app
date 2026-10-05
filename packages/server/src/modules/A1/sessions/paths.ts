import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SessionBucketOptions {
  readonly home?: string;
  readonly tempRoot?: string;
}

export interface SessionsRootOptions {
  readonly agentDir?: string;
  readonly home?: string;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isRelativeWithin(relative: string): boolean {
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function encodeRelativeSessionDirName(prefix: string, relative: string): string {
  const encoded = relative.replace(/[\\/:]/g, "-");
  return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-")}--`;
}

/**
 * Return omp's current path-derived bucket name without creating, migrating or
 * otherwise mutating the sessions directory.
 *
 * The temporary root is intentionally checked before home: on common Linux
 * machines `/tmp` is below `/home` only in synthetic tests, while on Windows
 * the temp root commonly nests below the user profile.
 */
export function sessionBucketName(cwd: string, options: SessionBucketOptions = {}): string {
  const resolvedCwd = path.resolve(cwd);
  const canonicalCwd = canonicalPath(resolvedCwd);
  const canonicalHome = canonicalPath(options.home ?? os.homedir());
  const canonicalTempRoot = canonicalPath(options.tempRoot ?? os.tmpdir());
  const homeRelative = path.relative(canonicalHome, canonicalCwd);
  const tempRelative = path.relative(canonicalTempRoot, canonicalCwd);

  if (isRelativeWithin(tempRelative)) {
    return encodeRelativeSessionDirName("-tmp", tempRelative);
  }
  if (isRelativeWithin(homeRelative)) {
    return encodeRelativeSessionDirName("-", homeRelative);
  }
  return encodeLegacyAbsoluteSessionDirName(canonicalCwd);
}

/** Resolve a cwd to its read-only session bucket below `sessionsRoot`. */
export function sessionBucketPath(
  cwd: string,
  sessionsRoot: string,
  options: SessionBucketOptions = {},
): string {
  return path.join(path.resolve(sessionsRoot), sessionBucketName(cwd, options));
}

/**
 * Resolve omp's normal session root. The XDG redirect is used only when omp's
 * `$XDG_DATA_HOME/omp` root already exists, matching omp's migration guard.
 */
export function defaultSessionsRoot(options: SessionsRootOptions = {}): string {
  const home = path.resolve(options.home ?? os.homedir());
  if (options.agentDir) return path.join(path.resolve(options.agentDir), "sessions");
  if (process.env.PI_CODING_AGENT_DIR) {
    return path.join(path.resolve(process.env.PI_CODING_AGENT_DIR), "sessions");
  }

  const configName = process.env.PI_CONFIG_DIR || ".omp";
  const profile = process.env.OMP_PROFILE || process.env.PI_PROFILE;
  const profileRoot = profile
    ? path.join(home, configName, "profiles", profile)
    : path.join(home, configName);
  const xdgData = process.env.XDG_DATA_HOME;
  if ((process.platform === "linux" || process.platform === "darwin") && xdgData) {
    const xdgRoot = path.join(path.resolve(xdgData), "omp");
    if (fs.existsSync(xdgRoot)) return path.join(xdgRoot, "sessions");
  }
  return path.join(profileRoot, "agent", "sessions");
}

/** The machine-global state root where omp names owner leases. */
export function defaultSessionOwnersRoot(home: string = os.homedir()): string {
  const xdgState = process.env.XDG_STATE_HOME;
  if ((process.platform === "linux" || process.platform === "darwin") && xdgState) {
    const xdgRoot = path.join(path.resolve(xdgState), "omp");
    if (fs.existsSync(xdgRoot)) return path.join(xdgRoot, "run", "session-owners");
  }
  return path.join(
    path.resolve(home),
    process.env.PI_CONFIG_DIR || ".omp",
    "run",
    "session-owners",
  );
}
