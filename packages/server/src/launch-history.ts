import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logging";
import { writeFileAtomic } from "./modules/A1/fs/atomic-file";

/** The file in the app's data folder that lists the digests of the launch tokens earlier starts printed. */
const HISTORY_FILE = "launch-links.json";
/** How many starts are remembered. A link printed further back than this reads as never printed. */
export const REMEMBERED_STARTS = 100;

const DIGEST = /^[0-9a-f]{64}$/;

export interface LaunchHistory {
  /** Digests of the launch tokens that earlier starts of this data folder printed. */
  readonly earlier: ReadonlySet<string>;
  /** Records this start's launch token, once: a start with the token of the start before it adds nothing. A file that cannot be written is logged; the app keeps running. */
  remember(token: string): Promise<void>;
}

/**
 * The digest a launch token is kept under. The history file holds digests only, never tokens, and a
 * digest cannot be turned back into the token it came from.
 */
export function launchTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The newest saved digests, or undefined when the text is not a list of them. */
function parseDigests(text: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  if (!parsed.every((item) => typeof item === "string" && DIGEST.test(item))) return undefined;
  return parsed.slice(-REMEMBERED_STARTS);
}

/**
 * Reads the saved digests. A missing file is no history. Any other problem is logged, and the start
 * counts it as no history: a link then reads as never printed, which changes only the words on the screen.
 */
function readDigests(dataDir: string, logger: Logger): string[] {
  let text: string;
  try {
    text = readFileSync(join(dataDir, HISTORY_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    logger.warn("launch-links.unreadable", { detail: String(error) });
    return [];
  }
  const digests = parseDigests(text);
  if (digests === undefined) {
    logger.warn("launch-links.unreadable", { detail: "the file is not a list of digests" });
    return [];
  }
  return digests;
}

/**
 * Reads the launch tokens that earlier starts of this data folder printed. `remember` then records a token
 * through the app's atomic file write, which keeps the file owner-only and never leaves it half written.
 */
export function openLaunchHistory(dataDir: string, logger: Logger): LaunchHistory {
  let digests = readDigests(dataDir, logger);
  return {
    earlier: new Set(digests),
    async remember(token) {
      const digest = launchTokenDigest(token);
      // The installed app keeps its token across restarts (`launch-token.ts`), so most starts repeat the last one.
      if (digests.at(-1) === digest) return;
      digests = [...digests, digest].slice(-REMEMBERED_STARTS);
      try {
        await writeFileAtomic(join(dataDir, HISTORY_FILE), `${JSON.stringify(digests)}\n`);
      } catch (error) {
        logger.warn("launch-links.not-saved", { detail: String(error) });
      }
    },
  };
}
