/**
 * Chats omp moved to a new file. omp 18.18 moves a chat it cannot keep writing (another omp process holds its file, or
 * the file changed under it) to a sibling with a new session id, named after the move (`<time>_<id>.jsonl`), whose
 * header names the old id in `continuationOf`; a moved copy can move again (omp `session/session-manager.ts`,
 * `#moveOffSessionFile`). Opening the old file then opens the newest copy, unless the old file went on after the move,
 * when both hold turns the other lacks and the old one stays (omp `session/session-listing.ts`, `findSessionContinuation`).
 * The app follows the same links, from the files alone: the server never loads omp's code.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { lastMessageTimestamp } from "./activity";
import { readSessionHeader } from "./summary";

/** One copy of a chat: its file and the session id its header holds. */
export interface SessionCopy {
  readonly file: string;
  readonly id: string;
}

/** What a continuation's header says: the id it continues, and when it moved (its header's time). */
export interface ContinuationLink {
  readonly continues: string;
  readonly movedAtMs: number;
}

/** More moves than any real chain; a longer one is not followed further. */
const MAX_MOVES = 32;

const GENERATED_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)\.jsonl$/;

/** The creation time and session id in omp's generated file name, `2026-01-02T03-04-05-678Z_<id>.jsonl`. */
export function generatedFileName(
  file: string,
): { readonly createdAtMs: number; readonly id: string } | undefined {
  const match = GENERATED_NAME.exec(path.basename(file));
  if (!match) return undefined;
  const createdAtMs = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  const id = match[6];
  return Number.isNaN(createdAtMs) || id === undefined ? undefined : { createdAtMs, id };
}

/** The link a chat file's header records, or undefined for a chat that continues none (or a file that cannot be read). */
export async function continuationLink(file: string): Promise<ContinuationLink | undefined> {
  const header = await readSessionHeader(file).catch(() => undefined);
  const continues = header?.continuationOf;
  if (typeof continues !== "string" || continues.length === 0) return undefined;
  const fromHeader =
    typeof header?.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
  const movedAtMs = Number.isNaN(fromHeader) ? generatedFileName(file)?.createdAtMs : fromHeader;
  return movedAtMs === undefined ? undefined : { continues, movedAtMs };
}

/** The time of a chat file's newest message, or NaN when it has none. */
async function newestMessageMs(file: string): Promise<number> {
  const stamp = await lastMessageTimestamp(file).catch(() => undefined);
  return stamp === undefined ? Number.NaN : Date.parse(stamp);
}

/**
 * Whether a chat whose newest message is at `newestMs` is held whole by a copy that moved at `movedAtMs`: it took no turn
 * after the move. A chat without messages is held whole.
 */
export function heldByCopy(newestMs: number, movedAtMs: number): boolean {
  return Number.isNaN(newestMs) || newestMs <= movedAtMs;
}

/** The copy in `copy`'s folder that continues it, with the newest message of those that hold it whole. */
async function nextCopy(copy: SessionCopy): Promise<SessionCopy | undefined> {
  const folder = path.dirname(copy.file);
  // A continuation is named after its move, which comes after the chat it continues was created.
  const since = generatedFileName(copy.file)?.createdAtMs ?? Number.NEGATIVE_INFINITY;
  const names = await readdir(folder).catch(() => [] as string[]);
  const newest = await newestMessageMs(copy.file);
  let best: { readonly copy: SessionCopy; readonly newestMs: number } | undefined;
  for (const name of names) {
    const named = generatedFileName(name);
    if (named === undefined || named.createdAtMs < since) continue;
    const file = path.join(folder, name);
    if (file === copy.file) continue;
    const link = await continuationLink(file);
    if (link?.continues !== copy.id || !heldByCopy(newest, link.movedAtMs)) continue;
    const newestMs = await newestMessageMs(file);
    if (best === undefined || newestMs > best.newestMs || Number.isNaN(best.newestMs)) {
      best = { copy: { file, id: named.id }, newestMs };
    }
  }
  return best?.copy;
}

/**
 * The newest copy of the chat in `file` (session `id`) when it moved to another file, following each move; undefined
 * when `file` itself is the copy to open.
 */
export async function newestCopy(file: string, id: string): Promise<SessionCopy | undefined> {
  let current: SessionCopy = { file: path.resolve(file), id };
  const seen = new Set([current.id]);
  for (let move = 0; move < MAX_MOVES; move++) {
    const next = await nextCopy(current);
    if (next === undefined || seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current.id === id ? undefined : current;
}
