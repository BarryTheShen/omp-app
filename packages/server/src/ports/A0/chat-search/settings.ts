import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatSearchSettings, SetChatSearchSettingsArgs } from "@omp-app/contracts";

/**
 * Search by meaning's settings, in the app's data folder: `search-settings.json` (`{ version: 1, enabled, address,
 * model }`) and the service's key alone in `search-key` (mode 600), so the settings file can be read without it and the
 * key is never put in anything sent to a page.
 */
export interface ChatSearchFiles {
  readonly settings: string;
  readonly key: string;
}

/** What the server uses: the settings and the key itself. */
export interface ChatSearchConfig {
  readonly enabled: boolean;
  readonly address: string;
  readonly model: string;
  readonly key: string | null;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw failure;
  }
}

/** A file written whole through one of its own beside it, so nothing reads half of one. */
async function writeWhole(path: string, text: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, mode === undefined ? undefined : { mode });
  if (mode !== undefined) await chmod(temporary, mode);
  await rename(temporary, path);
}

/** The settings as kept; off with nothing set when the app has written none (or its file cannot be read). */
export async function readChatSearchConfig(files: ChatSearchFiles): Promise<ChatSearchConfig> {
  const [text, key] = await Promise.all([readText(files.settings), readText(files.key)]);
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === 1
    ) {
      saved = parsed as Record<string, unknown>;
    }
  } catch {
    saved = {};
  }
  return {
    enabled: saved.enabled === true,
    address: typeof saved.address === "string" ? saved.address : "",
    model: typeof saved.model === "string" ? saved.model : "",
    key: key === null || key.trim() === "" ? null : key.trim(),
  };
}

/** What a page sees of them: the key only as whether there is one. */
export function shownSettings(config: ChatSearchConfig): ChatSearchSettings {
  return {
    enabled: config.enabled,
    address: config.address,
    model: config.model,
    hasKey: config.key !== null,
  };
}

/** An address the service is reached at: http(s), no credentials in it, its trailing slashes dropped. */
export function addressProblem(address: string): string | null {
  if (address === "") return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return `"${address}" is not an address. It starts with https:// (or http://).`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return "The address starts with https:// or http://.";
  if (url.username !== "" || url.password !== "")
    return "Put the key in its own field, not in the address.";
  return null;
}

/** Changes the settings named, and the key when one is given ("" removes it); the others stay. */
export async function writeChatSearchConfig(
  files: ChatSearchFiles,
  change: SetChatSearchSettingsArgs,
): Promise<ChatSearchConfig> {
  const before = await readChatSearchConfig(files);
  const address =
    change.address === undefined ? before.address : change.address.trim().replace(/\/+$/, "");
  const problem = addressProblem(address);
  if (problem !== null) throw new Error(problem);
  const model = change.model === undefined ? before.model : change.model.trim();
  const enabled = change.enabled ?? before.enabled;
  if (enabled && (address === "" || model === "")) {
    throw new Error("Set the service's address and model before turning search by meaning on.");
  }
  await writeWhole(
    files.settings,
    `${JSON.stringify({ version: 1, enabled, address, model }, null, 2)}\n`,
  );
  if (change.key !== undefined) {
    if (change.key.trim() === "") await rm(files.key, { force: true });
    else await writeWhole(files.key, change.key.trim(), 0o600);
  }
  return await readChatSearchConfig(files);
}
