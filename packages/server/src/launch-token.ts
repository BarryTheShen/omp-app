/**
 * The launch token: the secret in the app's link (`…/#token=…`). The installed command (`scripts/omp-app.ts`) keeps
 * it in a file beside its instance record and uses it at every start, so a link saved on this computer (a bookmark,
 * the desktop window's way to this computer's app) keeps working after a restart or a reboot. A server that pairs
 * devices takes it from this computer's pages only.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NO_FILE, writeFileAtomic } from "./modules/A1/fs/atomic-file";

/** The file in the app's state folder (`$XDG_STATE_HOME/omp-app`) that keeps the launch token. */
const TOKEN_FILE = "launch-token";
/** A launch token: 32 random bytes in base64url, without padding (43 characters). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A new launch token: 32 random bytes in base64url. */
export function newLaunchToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** Where the installed command keeps its launch token, in the app's state folder. */
export function launchTokenFile(stateDir: string): string {
  return join(stateDir, TOKEN_FILE);
}

export type KeptLaunchToken =
  /** Read from the file an earlier start saved, or saved by this start for the next ones. */
  | { readonly token: string; readonly kept: true }
  /** The file could not be read or written: this start's link changes at the next start. */
  | { readonly token: string; readonly kept: false; readonly reason: string };

/** The saved token; undefined when there is no file, "damaged" when the file holds no token. */
async function readSavedToken(path: string): Promise<string | undefined | "damaged"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const token = text.trim();
  return TOKEN_SHAPE.test(token) ? token : "damaged";
}

/**
 * The launch token for this start: the saved one, else a new one, saved for the starts after it. The file is written
 * owner-only and whole. Two starts at once save one token between them: a new file is written only while none exists,
 * under the file's lock, and the start that finds one there uses it. A file that holds no token is replaced. When the
 * file cannot be read or written, the start gets a token of its own, and the caller logs the reason.
 */
export async function keepLaunchToken(path: string): Promise<KeptLaunchToken> {
  try {
    const saved = await readSavedToken(path);
    if (saved !== undefined && saved !== "damaged") return { token: saved, kept: true };
    const token = newLaunchToken();
    try {
      await writeFileAtomic(
        path,
        `${token}\n`,
        saved === undefined ? { expectedHash: NO_FILE } : {},
      );
      return { token, kept: true };
    } catch (error) {
      const other = await readSavedToken(path);
      if (other !== undefined && other !== "damaged") return { token: other, kept: true };
      throw error;
    }
  } catch (error) {
    return {
      token: newLaunchToken(),
      kept: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
