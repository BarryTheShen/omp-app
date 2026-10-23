import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { isJsonObject } from "./parser";
import type { RecordedWorkerStatus } from "./types";

const RECORDED_OUTCOMES: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);
const TASK_RESULT_OPEN = Buffer.from("<task-result", "utf8");
const TASK_RESULT_TAG = /<task-result\b([^>]*)>/gu;
const TAG_ATTRIBUTE = /([a-z-]+)="([^"]*)"/gu;
const NEWLINE = 0x0a;
/** Bytes per read. The scan holds one chunk of this size, never the file. */
const DEFAULT_CHUNK_BYTES = 256 * 1024;
/**
 * A record longer than this is not parsed, so its worker keeps no recorded status. A worker's envelope is bounded by its
 * preview, so no real record comes near this.
 */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
/**
 * The leading bytes that identify a file: its header and the title slot omp rewrites in place. A scan resumes only when
 * these are unchanged, so a rewritten head is read again from its start.
 */
const PREFIX_BYTES = 64 * 1024;

export interface RecordedOutcomeReadOptions {
  /** Bytes per read. Tests use a few bytes to cross read boundaries. */
  readonly chunkBytes?: number;
  /** Called with the byte count of each read the scan makes. Tests use it to see what a scan reads. */
  readonly onRead?: (bytes: number) => void;
}

/**
 * What one scan of a parent session found, and where it stopped. The next scan of the same file resumes at `offset`
 * when the file has grown from `size` with the same head.
 */
export interface RecordedOutcomeState {
  readonly dev: number;
  readonly ino: number;
  /** The file's size when the scan read it. */
  readonly size: number;
  /** sha256 of the file's first `min(PREFIX_BYTES, size)` bytes when the scan read it. */
  readonly prefixHash: string;
  /** The byte offset after the last complete line the scan read. A partial last line is read again by the next scan. */
  readonly offset: number;
  readonly outcomes: ReadonlyMap<string, RecordedWorkerStatus>;
}

/**
 * The outcomes a parent session records for its workers: `<task-result id="…" status="…">` in an async result (a
 * `custom_message` named `async-result`) or in a `task` tool result. The last record for a worker wins. A file that is
 * missing or unreadable records none, and the result is undefined.
 *
 * The file is read in chunks and never whole, so memory is one chunk plus the records that carry a result tag, and only
 * those lines are parsed. `previous` is the state the last scan of this file ended with, when the caller kept it: the
 * scan then reads only the bytes appended since, when the file grew and its head is unchanged. omp appends to a
 * session; a rewrite either replaces the file under a new inode or shortens it, and then the file is read from its start.
 */
export async function scanRecordedOutcomes(
  file: string,
  previous: RecordedOutcomeState | undefined,
  options: RecordedOutcomeReadOptions = {},
): Promise<RecordedOutcomeState | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    const prefixHash = await prefixHashOf(handle, info.size);
    const base = await resumable(previous, info, handle);
    const outcomes = new Map<string, RecordedWorkerStatus>(base?.outcomes ?? []);
    const found = await linesWithTag(handle, base?.offset ?? 0, info.size, options);
    for (const span of found.spans) {
      const text = await readRecord(handle, span);
      if (text !== undefined) applyRecord(text, outcomes);
    }
    return {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      prefixHash,
      offset: found.scannedTo,
      outcomes,
    };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** The state to resume from: the file is the one `previous` was taken from, grown or unchanged, with the same head. */
async function resumable(
  previous: RecordedOutcomeState | undefined,
  info: { readonly dev: number; readonly ino: number; readonly size: number },
  handle: FileHandle,
): Promise<RecordedOutcomeState | undefined> {
  if (previous === undefined || previous.dev !== info.dev || previous.ino !== info.ino) {
    return undefined;
  }
  if (info.size < previous.size) return undefined;
  return (await prefixHashOf(handle, previous.size)) === previous.prefixHash ? previous : undefined;
}

/** sha256 of the file's first `min(PREFIX_BYTES, size)` bytes. */
async function prefixHashOf(handle: FileHandle, size: number): Promise<string> {
  const head = Buffer.alloc(Math.min(PREFIX_BYTES, size));
  const { bytesRead } = await handle.read(head, 0, head.length, 0);
  return createHash("sha256").update(head.subarray(0, bytesRead)).digest("hex");
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Reads [from, size) in chunks. Returns the complete lines that carry a result tag, as byte spans, and the offset after
 * the last complete line, so a partial last line waits for the next scan.
 */
async function linesWithTag(
  handle: FileHandle,
  from: number,
  size: number,
  options: RecordedOutcomeReadOptions,
): Promise<{ readonly scannedTo: number; readonly spans: readonly Span[] }> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const chunk = Buffer.allocUnsafe(chunkBytes);
  const overlap = TASK_RESULT_OPEN.length - 1;
  const spans: Span[] = [];
  let position = from;
  let lineStart = from;
  let scannedTo = from;
  let tagged = false;
  // The last bytes of the current line read so far: enough to find a tag that a read boundary splits.
  let tail: Buffer = Buffer.alloc(0);
  while (position < size) {
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(chunkBytes, size - position),
      position,
    );
    if (bytesRead === 0) break;
    options.onRead?.(bytesRead);
    const data = chunk.subarray(0, bytesRead);
    let at = 0;
    while (at < data.length) {
      const newline = data.indexOf(NEWLINE, at);
      const piece = data.subarray(at, newline === -1 ? data.length : newline);
      if (!tagged) {
        tagged =
          piece.includes(TASK_RESULT_OPEN) ||
          (tail.length > 0 &&
            Buffer.concat([tail, piece.subarray(0, overlap)]).includes(TASK_RESULT_OPEN));
      }
      if (newline === -1) {
        tail = lastBytes(tail, piece, overlap);
        break;
      }
      const end = position + newline;
      if (tagged) spans.push({ start: lineStart, end });
      lineStart = end + 1;
      scannedTo = lineStart;
      tagged = false;
      tail = Buffer.alloc(0);
      at = newline + 1;
    }
    position += bytesRead;
  }
  return { scannedTo, spans };
}

/** The last `length` bytes of `head` followed by `piece`, copied: `piece` is a view of a read buffer the next read reuses. */
function lastBytes(head: Buffer, piece: Buffer, length: number): Buffer {
  if (piece.length >= length) return Buffer.from(piece.subarray(piece.length - length));
  const joined = Buffer.concat([head, piece]);
  return Buffer.from(joined.subarray(Math.max(0, joined.length - length)));
}

/** Reads one record's bytes. A record too long to parse, or one the file no longer holds, yields nothing. */
async function readRecord(handle: FileHandle, span: Span): Promise<string | undefined> {
  const length = span.end - span.start;
  if (length > MAX_RECORD_BYTES) return undefined;
  const bytes = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(bytes, filled, length - filled, span.start + filled);
    if (bytesRead === 0) return undefined;
    filled += bytesRead;
  }
  return bytes.toString("utf8");
}

/** The text of a record: its string content, or the text parts of its content list. */
function recordText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

/** Adds the outcomes one line records, when it is an async result or a task tool result. */
function applyRecord(line: string, outcomes: Map<string, RecordedWorkerStatus>): void {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (!isJsonObject(value)) return;
  const message =
    value.type === "message" && isJsonObject(value.message) ? value.message : undefined;
  const text =
    value.type === "custom_message" && value.customType === "async-result"
      ? recordText(value.content)
      : message?.role === "toolResult" && message.toolName === "task"
        ? recordText(message.content)
        : "";
  for (const tag of text.matchAll(TASK_RESULT_TAG)) {
    const attributes = new Map<string, string>();
    for (const attribute of (tag[1] ?? "").matchAll(TAG_ATTRIBUTE)) {
      attributes.set(attribute[1] ?? "", attribute[2] ?? "");
    }
    const id = attributes.get("id");
    const status = attributes.get("status");
    if (id !== undefined && status !== undefined && RECORDED_OUTCOMES.has(status)) {
      outcomes.set(id, status as RecordedWorkerStatus);
    }
  }
}
