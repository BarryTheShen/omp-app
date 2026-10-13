import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AppFailure } from "@omp-app/contracts";
import { isJsonObject } from "./parser";
import { isCollectedTranscriptName } from "./subagents";

/** One page of a worker transcript, shaped like omp's `get_subagent_messages` result. */
export interface SubagentPage {
  readonly sessionFile: string;
  readonly fromByte: number;
  readonly nextByte: number;
  readonly reset: boolean;
  readonly entries: Record<string, unknown>[];
  readonly messages: Record<string, unknown>[];
}

const NOT_FOUND = "No subagent transcript is at that path.";
const NOT_BELOW_CHAT = "A subagent transcript sits below a chat session.";
/** Most bytes one page returns. A longer transcript comes in pages: each page's `nextByte` is where the next one starts. */
export const SUBAGENT_PAGE_BYTES = 4 * 1024 * 1024;
/**
 * Most bytes one entry may take. A page holds a whole entry even when the entry is larger than a page, so that entry
 * comes back alone. An entry larger than this is refused, since no page could hold it.
 */
export const SUBAGENT_ENTRY_MAX_BYTES = 16 * 1024 * 1024;
const ENTRY_TOO_LARGE = "A transcript entry is larger than 16 MiB, so it cannot be read.";
const READ_CHUNK_BYTES = 1024 * 1024;

function refuse(code: "invalid_args" | "not_found" | "internal", message: string): AppFailure {
  return new AppFailure({ code, message, retryable: false });
}

async function isFileAt(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

async function isDirectoryAt(dir: string): Promise<boolean> {
  try {
    return (await fs.lstat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The real path of a worker transcript that the collector lists below `sessionsRoot`. The layout is
 * `<bucket>/<chat>.jsonl` beside `<bucket>/<chat>/`, and a worker sits the same way beside its
 * parent's directory, at any depth. Every level must be a regular file with a real directory beside
 * it, so symlinks never count, and each name must pass the collector's filter. A `..` segment is
 * refused before the path is resolved.
 */
export async function subagentTranscriptPath(
  sessionsRoot: string,
  sessionFile: string,
): Promise<string> {
  if (!path.isAbsolute(sessionFile)) {
    throw refuse("invalid_args", "A subagent transcript path must be absolute.");
  }
  if (sessionFile.split(/[\\/]/u).includes("..")) {
    throw refuse("invalid_args", "A subagent transcript path must not contain .. segments.");
  }
  const relative = path.relative(sessionsRoot, path.resolve(sessionFile));
  const [bucket, ...levels] = relative.split(path.sep);
  if (relative === "" || path.isAbsolute(relative) || bucket === undefined || bucket === "..") {
    throw refuse("invalid_args", "The subagent transcript is outside the sessions folder.");
  }
  const last = levels[levels.length - 1];
  if (last === undefined || levels.length < 2) throw refuse("invalid_args", NOT_BELOW_CHAT);

  let dir = path.join(sessionsRoot, bucket);
  if (!(await isDirectoryAt(dir))) throw refuse("not_found", NOT_FOUND);
  for (const stem of levels.slice(0, -1)) {
    if (!isCollectedTranscriptName(`${stem}.jsonl`)) throw refuse("invalid_args", NOT_BELOW_CHAT);
    if (!(await isFileAt(path.join(dir, `${stem}.jsonl`)))) {
      throw refuse("not_found", NOT_FOUND);
    }
    dir = path.join(dir, stem);
    if (!(await isDirectoryAt(dir))) throw refuse("not_found", NOT_FOUND);
  }
  if (!isCollectedTranscriptName(last)) {
    throw refuse("invalid_args", "The file is not a subagent transcript.");
  }
  const transcript = path.join(dir, last);
  if (!(await isFileAt(transcript))) throw refuse("not_found", NOT_FOUND);
  return transcript;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Records from complete lines. A malformed line is skipped, as omp's lenient parser skips it. */
function parseEntries(text: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const value = parseJson(trimmed);
    if (isJsonObject(value)) entries.push(value);
  }
  return entries;
}

/** The bytes from `from` up to `to`, as far as the file holds them. */
async function readRange(handle: fs.FileHandle, from: number, to: number): Promise<Buffer> {
  const bytes = Buffer.alloc(to - from);
  let filled = 0;
  while (filled < bytes.length) {
    const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, from + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return bytes.subarray(0, filled);
}

/**
 * The position of the first newline from `from` on, or -1 when the file ends first. An entry with no newline before
 * `limit` is refused: no page could hold it.
 */
async function firstNewline(
  handle: fs.FileHandle,
  from: number,
  size: number,
  limit: number,
): Promise<number> {
  let position = from;
  while (position < size) {
    if (position >= limit) throw refuse("internal", ENTRY_TOO_LARGE);
    const chunk = await readRange(handle, position, Math.min(size, position + READ_CHUNK_BYTES));
    const index = chunk.indexOf(0x0a);
    if (index >= 0) return position + index;
    if (chunk.length === 0) break;
    position += chunk.length;
  }
  return -1;
}

/**
 * One page from a byte cursor: the complete lines from `fromByte`, parsed the way omp's reader parses them. A page is
 * at most `SUBAGENT_PAGE_BYTES`, unless its one entry is larger. A cursor past the end starts again at 0 and says so
 * with `reset`. A last line with no newline yet is left for the next page. The file is only ever read.
 */
export async function readSubagentPage(file: string, fromByte: number): Promise<SubagentPage> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const reset = fromByte > size;
    const start = reset ? 0 : fromByte;
    const windowEnd = Math.min(size, start + SUBAGENT_PAGE_BYTES);
    let bytes = await readRange(handle, start, windowEnd);
    let lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0 && windowEnd < size) {
      // The entry at the cursor is larger than a page: it comes back whole, and alone.
      const newline = await firstNewline(handle, windowEnd, size, start + SUBAGENT_ENTRY_MAX_BYTES);
      if (newline >= 0) {
        bytes = await readRange(handle, start, newline + 1);
        lastNewline = bytes.length - 1;
      }
    }
    const complete = lastNewline < 0 ? Buffer.alloc(0) : bytes.subarray(0, lastNewline + 1);
    const entries = parseEntries(complete.toString("utf8"));
    return {
      sessionFile: file,
      fromByte: start,
      nextByte: start + complete.length,
      reset,
      entries,
      messages: entries.flatMap((entry) => {
        const message = entry.message;
        return entry.type === "message" && isJsonObject(message) ? [message] : [];
      }),
    };
  } finally {
    await handle.close();
  }
}
