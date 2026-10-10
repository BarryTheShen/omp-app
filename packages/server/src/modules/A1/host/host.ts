import { lstat, realpath } from "node:fs/promises";
import { homedir, hostname as systemHostname } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AppFailure, type HostMetadata } from "@omp-app/contracts";

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

export interface HostMetadataOptions {
  /** Home directory used for `~` replacement; defaults to the process home directory. */
  readonly homeDir?: string;
  /** Hostname source used by deterministic tests; defaults to the local system hostname. */
  readonly hostname?: string;
}

/**
 * Reads local host metadata without returning the raw folder path.
 *
 * Existing folders inside the canonical home directory are displayed as `~` paths. Folders
 * outside it remain absolute so a path cannot be made to look home-relative when it is not.
 */
export async function readHostMetadata(
  folder: string,
  options: HostMetadataOptions = {},
): Promise<HostMetadata> {
  try {
    const canonicalFolder = await validateFolder(folder);
    const canonicalHome = await realpath(resolve(options.homeDir ?? homedir()));
    const displayPath = displayFolderPath(canonicalFolder, canonicalHome);
    const hostname = firstHostnameComponent(options.hostname ?? systemHostname());
    return { hostname, displayPath };
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    throw toFailure(error);
  }
}

async function validateFolder(folder: string): Promise<string> {
  if (
    typeof folder !== "string" ||
    folder.length === 0 ||
    !isAbsolute(folder) ||
    WINDOWS_ABSOLUTE_PATH.test(folder) ||
    folder.includes("\0")
  ) {
    throw new AppFailure({
      code: "invalid_args",
      message: "Enter a folder path that starts with /.",
      retryable: false,
    });
  }
  const canonicalFolder = await realpath(resolve(folder));
  const info = await lstat(canonicalFolder);
  if (!info.isDirectory()) {
    throw new AppFailure({
      code: "invalid_args",
      message: "That path isn't a folder. Check the path.",
      retryable: false,
    });
  }
  return canonicalFolder;
}

function displayFolderPath(folder: string, home: string): string {
  const fromHome = relative(home, folder);
  if (fromHome.length === 0) return "~";
  if (isRelativePath(fromHome)) {
    return `~/${fromHome.split(sep).join("/")}`;
  }
  return folder.split(sep).join("/");
}

function isRelativePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

function firstHostnameComponent(value: string): string {
  const component = value.trim().split(".", 1)[0] ?? "";
  if (component.length === 0) {
    throw new AppFailure({
      code: "unavailable",
      message: "The local hostname is unavailable.",
      retryable: false,
      capability: "host.metadata",
    });
  }
  return component;
}

function toFailure(error: unknown): AppFailure {
  const code = errorCode(error);
  if (code === "ENOENT") {
    return new AppFailure({
      code: "not_found",
      message: "That folder doesn't exist. Check the path.",
      retryable: false,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new AppFailure({
      code: "permission",
      message: "You don't have permission to open that folder.",
      retryable: false,
    });
  }
  return new AppFailure(
    { code: "internal", message: "That folder couldn't be opened.", retryable: false },
    { cause: error },
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
