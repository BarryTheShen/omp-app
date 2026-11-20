/**
 * What a chat is told about the computers it can reach through agent access (#20, PLAN §7e): their names, how to reach
 * them, and how to ask their owner for a folder. The server names its access `ssh_config` in the chats' environment
 * only while agent access is on there (`ACCESS_SSH_CONFIG_ENV`); its `Host` blocks are the linked computers. The note
 * goes after whatever omp appends to the system prompt anyway (`--append-system-prompt` or `APPEND_SYSTEM.md`).
 */
import { readFile } from "node:fs/promises";

/** The server's access `ssh_config`, set for its chats while agent access is on. */
export const ACCESS_SSH_CONFIG_ENV = "OMP_APP_ACCESS_SSH_CONFIG";

/** The computers' names: the `Host` lines the server writes (`SshFiles`), one name each. */
export function accessHosts(config: string): string[] {
  return config
    .split("\n")
    .map((line) => /^Host ([A-Za-z0-9-]+)\s*$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** A path as one shell word. */
const shellWord = (text: string): string =>
  /^[A-Za-z0-9_./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/** The note for these computers; null without any. */
export function accessNote(configPath: string, hosts: readonly string[]): string | null {
  if (hosts.length === 0) return null;
  const ssh = `ssh -F ${shellWord(configPath)}`;
  return [
    "## Computers you can reach (omp-app agent access)",
    "",
    `Linked to this omp-app server: ${hosts.join(", ")}. Run a command on one with \`${ssh} <name> '<command>'\` (without a command for a shell). A computer answers only while its owner has agent access turned on, and only chats the owner allowed: the first time this chat connects, it is refused and the owner is asked on the computer; tell the user and try again once they have allowed it. When the connection is refused because access is off, ask the owner to turn it on.`,
    "",
    "There you work as a separate account (omp-agent) that cannot read the owner's files. To use one of the owner's folders, run on that computer `omp-app-device ask-folder '~/<folder>' --why '<one line>'`, adding `--write` only when files must change. It waits until the owner answers (up to 10 minutes) and prints the path to use. Secret folders and the whole home folder are always refused.",
  ].join("\n");
}

/** The note for the computers in the server's access `ssh_config`, as `env` names it; null when there is none. */
export async function readAccessNote(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  const path = env[ACCESS_SSH_CONFIG_ENV];
  if (path === undefined || path === "") return null;
  const config = await readFile(path, "utf8").catch(() => null);
  return config === null ? null : accessNote(path, accessHosts(config));
}

/** omp's append prompt with the note after it. */
export function withAccessNote(
  append: string | undefined,
  note: string | null,
): string | undefined {
  if (note === null) return append;
  return append === undefined || append.trim() === "" ? note : `${append}\n\n${note}`;
}
