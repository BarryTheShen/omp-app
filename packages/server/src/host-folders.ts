/**
 * Host folders: where the server runs the chats of a project whose files are on another computer, the one of the app
 * that shows omp app in a panel (VS Code on a laptop). `<app data>/host-folders/<host>/<project>-<id>`, made empty and
 * private: the chats of one project share it, so they are listed together, and nothing in it is the project's.
 *
 * The folder is the mark: a chat started in one runs with `--app-host-files=<host>` (`hostFilesArguments`), so the
 * chat host leaves out omp's tools that would work on this computer's files and shell (`chat-host/host-files.ts`).
 */
import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { CHAT_HOST_FILES_ARG } from "@omp-app/contracts/chat-host/args";

export const HOST_FOLDERS_DIRECTORY = "host-folders";

/** An app's name, as hosts name themselves (`MESSAGE_HOST_PATTERN`). */
const HOST = /^[a-z][a-z0-9-]{0,31}$/;
/** The id a host derives from the project's folder on its computer: hex, of which the first 12 are kept. */
const ID = /^[a-f0-9]{8,64}$/;

/** A project's name as a folder name: lower case, letters, digits, dots, dashes and underscores, 48 at most. */
export function projectFolderName(project: string): string {
  const name = project
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48);
  return name === "" ? "project" : name;
}

/** Why a host folder cannot be made, in words for the panel. */
export class HostFolderRefused extends Error {}

/** The folder for `host`'s project, made if needed; refuses a host or an id that is not one. */
export async function ensureHostFolder(
  appDataDir: string,
  host: string,
  project: string,
  id: string,
): Promise<string> {
  if (!HOST.test(host)) throw new HostFolderRefused(`"${host}" is not an app's name.`);
  if (!ID.test(id)) throw new HostFolderRefused("The project's id is not one this app takes.");
  const folder = join(
    appDataDir,
    HOST_FOLDERS_DIRECTORY,
    host,
    `${projectFolderName(project)}-${id.slice(0, 12)}`,
  );
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return folder;
}

/**
 * The chat host's arguments for a chat in `folder`: `--app-host-files=<host>` when it is a host folder, none otherwise.
 * Compared on resolved paths: the server made the folder and gives its own path.
 */
export function hostFilesArguments(folder: string, appDataDir: string): readonly string[] {
  const inside = relative(resolve(appDataDir, HOST_FOLDERS_DIRECTORY), resolve(folder));
  const parts = inside.split(sep);
  if (inside === "" || inside.startsWith("..") || parts.length !== 2) return [];
  const [host] = parts;
  return host !== undefined && HOST.test(host) ? [`${CHAT_HOST_FILES_ARG}=${host}`] : [];
}
