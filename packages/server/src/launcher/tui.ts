/**
 * `omp-app tui` (SDK plan H5.7), the terminal fallback: omp's own terminal app, in a tmux session, on the app's chats.
 * It runs the program the app's chats run (`ompCommand`: the chat host, whose bare start is omp's command line at the
 * pinned release), so the two read and write the same session files; omp's session lease decides which of them writes
 * a chat (`session-manager.ts:1096-1128` at 18.12.6). One tmux session per folder: a second start attaches to it, so a
 * terminal left with tmux's detach, or a lost SSH connection, comes back with its turn still running.
 */
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

/**
 * The variables that decide where omp keeps its chats and their leases (`@oh-my-pi/pi-utils`' `dirs.ts` at 18.12.6), passed to the
 * terminal app as this command has them: tmux starts a session with its server's environment, and a server started
 * earlier, from another shell, may have other values. Keys and other secrets are not passed, since they would show in
 * the process list.
 */
const STORAGE_VARIABLES = [
  "HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

/**
 * omp settings the terminal app starts with, given to omp as a `--config` overlay, which outranks the user's own
 * `config.yml` (omp 18.18.5 `config/settings.ts`, `getProvenance`). The app's omp changes with the app's releases, so
 * omp's self-update (`update.auto`, omp 18.17) stays off and never replaces it.
 */
export const TUI_SETTINGS = [
  "# Written by omp-app for `omp-app tui`: the app's omp is updated with the app, not by itself.",
  "update:",
  "  auto: false",
  "",
].join("\n");

/** Where `omp-app tui` writes {@link TUI_SETTINGS}: the app's own data folder. */
export function tuiSettingsFile(appDataFolder: string): string {
  return join(appDataFolder, "tui-settings.yml");
}

/** The tmux session of one folder's terminal app: named after the folder, and unique to its whole path. */
export function tuiSessionName(folder: string): string {
  const base = basename(folder)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const hash = createHash("sha256").update(folder).digest("hex").slice(0, 8);
  return `omp-app-${base === "" ? "folder" : base}-${hash}`;
}

/** The environment the terminal app gets: the chats' search path, and where omp keeps its chats, where it is set. */
export function tuiEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  searchPath: string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = { PATH: searchPath };
  for (const name of STORAGE_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== "") result[name] = value;
  }
  return result;
}

export interface TuiCommandOptions {
  /** The tmux program. */
  readonly tmux: string;
  /** The folder omp works in, absolute. */
  readonly folder: string;
  /** omp's command line: `ompCommand()`. */
  readonly omp: readonly string[];
  /** omp's own options, from after `--`. */
  readonly ompArgs: readonly string[];
  /** {@link tuiSettingsFile}: given to omp first, so options after `--` (another `--config`) still apply. */
  readonly settingsFile: string;
  readonly env: Readonly<Record<string, string>>;
  /** This command runs inside tmux (`$TMUX` is set): it switches to the folder's session instead of nesting one. */
  readonly insideTmux: boolean;
  /** The folder's session is already running. */
  readonly running: boolean;
}

/**
 * The tmux commands that open the folder's terminal app, or go back to it, in order. Outside tmux: one session per
 * folder, attached to when it runs already (`new-session -A`, which then ignores the command). Inside tmux: the
 * session is started detached when it does not run, then this client switches to it.
 */
export function tuiCommands(options: TuiCommandOptions): readonly (readonly string[])[] {
  const name = tuiSessionName(options.folder);
  const variables = Object.entries(options.env).map(([key, value]) => `${key}=${value}`);
  const program = [
    "env",
    ...variables,
    ...options.omp,
    "--config",
    options.settingsFile,
    ...options.ompArgs,
  ];
  if (!options.insideTmux) {
    return [[options.tmux, "new-session", "-A", "-s", name, "-c", options.folder, ...program]];
  }
  const start = [options.tmux, "new-session", "-d", "-s", name, "-c", options.folder, ...program];
  const switchTo = [options.tmux, "switch-client", "-t", `=${name}`];
  return options.running ? [switchTo] : [start, switchTo];
}
