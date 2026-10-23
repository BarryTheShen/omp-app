import type { FileHandle } from "node:fs/promises";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AppFailure, EntryId } from "@omp-app/contracts";
import { isJsonObject } from "./parser";

/** A tool output or bash output longer than this is shortened to its head and tail. */
export const OUTPUT_CUT_BYTES = 64 * 1024;
const OUTPUT_HEAD_BYTES = 48 * 1024;
const OUTPUT_TAIL_BYTES = 16 * 1024;
/** The serialized entries of one window: about 4 MB, well under the 5 MB first-frame goal. */
export const DEFAULT_WINDOW_BYTES = 4 * 1024 * 1024;
/** The largest saved picture a window carries: no card draws a bigger one (apps/web U3/tool-card/result-image.ts). */
export const IMAGE_BLOB_MAX_BYTES = 4 * 1024 * 1024;
/** omp saves a picture beside the session and keeps `blob:sha256:<hex>` in place of its bytes. */
const IMAGE_BLOB_REF = /^blob:sha256:([0-9a-f]{64})$/;

const SCAN_CHUNK_BYTES = 1024 * 1024;
const HEAD_FINGERPRINT_BYTES = 256;
const CACHED_FILES = 4;
const NEWLINE = 10;

/** Where one entry's JSON line sits in the file. */
export interface EntryRecord {
  readonly parentId: EntryId | null;
  readonly offset: number;
  /** The line's length, including its newline. */
  readonly length: number;
}

/** A session file's entries by id, scanned up to `scannedTo`: the end of its last complete line. */
export interface FileIndex {
  /** The file's size and mtime when it was indexed: an unchanged pair means the index is current. */
  readonly size: number;
  readonly mtimeMs: number;
  readonly head: string;
  readonly scannedTo: number;
  readonly records: ReadonlyMap<EntryId, EntryRecord>;
  readonly fileLastId: EntryId | null;
}

export interface WindowRequest {
  readonly leafId?: EntryId;
  readonly before?: EntryId;
  readonly byteBudget?: number;
  /** omp's blob folder beside the sessions: where the pictures a window's references point at are kept. */
  readonly blobsDir?: string;
}

export interface WindowResult {
  readonly leafId: EntryId | null;
  readonly fileLastId: EntryId | null;
  readonly entries: Record<string, unknown>[];
  readonly oldestId: EntryId | null;
  readonly hasOlder: boolean;
}

const cache = new Map<string, FileIndex>();

function notFound(message: string): AppFailure {
  return new AppFailure({ code: "not_found", message, retryable: false });
}

async function readBytes(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** Parses one complete line. Only entries with a string id take part in a branch. */
function parseEntryLine(
  line: Buffer,
  offset: number,
  length: number,
): { id: EntryId; record: EntryRecord; entry: Record<string, unknown> } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isJsonObject(value) || typeof value.id !== "string" || value.id.length === 0)
    return undefined;
  if (value.type === "session" || value.type === "title") return undefined;
  const id = EntryId.parse(value.id);
  const parentId =
    typeof value.parentId === "string" && value.parentId.length > 0
      ? EntryId.parse(value.parentId)
      : null;
  return { id, record: { parentId, offset, length }, entry: value };
}

/** Records one complete line in a forward index. */
function recordLine(
  line: Buffer,
  offset: number,
  length: number,
  records: Map<EntryId, EntryRecord>,
): EntryId | undefined {
  const parsed = parseEntryLine(line, offset, length);
  if (parsed === undefined) return undefined;
  records.set(parsed.id, parsed.record);
  return parsed.id;
}

interface BackwardLine {
  readonly line: Buffer;
  readonly offset: number;
  readonly length: number;
}

/** Reads complete JSONL lines newest first, leaving an incomplete final line out. */
async function* readLinesBackwards(handle: FileHandle, size: number): AsyncGenerator<BackwardLine> {
  let end = size;
  let carry: Buffer | undefined;
  let skipIncompleteTail = true;
  while (end > 0) {
    const from = Math.max(0, end - SCAN_CHUNK_BYTES);
    const chunk = await readBytes(handle, from, end - from);
    if (chunk.length === 0) return;
    end = from;

    const buffer = carry === undefined ? chunk : Buffer.concat([chunk, carry]);
    carry = undefined;
    let scanEnd = buffer.length;
    if (skipIncompleteTail) {
      const lastNewline = buffer.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        carry = buffer;
        continue;
      }
      scanEnd = lastNewline + 1;
      skipIncompleteTail = false;
    }

    let lineEnd = scanEnd - 1;
    while (lineEnd >= 0) {
      const previousNewline = lineEnd === 0 ? -1 : buffer.lastIndexOf(NEWLINE, lineEnd - 1);
      const lineStart = previousNewline + 1;
      if (previousNewline === -1 && from > 0) {
        carry = buffer.subarray(0, lineEnd + 1);
        break;
      }
      yield {
        line: buffer.subarray(lineStart, lineEnd),
        offset: from + lineStart,
        length: lineEnd - lineStart + 1,
      };
      lineEnd = previousNewline;
    }
  }
}

/** Scans the complete lines from `from` to `to`; a partial last line is left for the next scan. */
async function scanRange(
  handle: FileHandle,
  from: number,
  to: number,
  records: Map<EntryId, EntryRecord>,
): Promise<{ scannedTo: number; lastId: EntryId | undefined }> {
  let base = from;
  let carry = Buffer.alloc(0);
  let position = from;
  let lastId: EntryId | undefined;
  while (position < to) {
    const chunk = await readBytes(handle, position, Math.min(SCAN_CHUNK_BYTES, to - position));
    if (chunk.length === 0) break;
    position += chunk.length;
    const buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    let start = 0;
    let newline = buffer.indexOf(NEWLINE, start);
    while (newline !== -1) {
      const id = recordLine(
        buffer.subarray(start, newline),
        base + start,
        newline - start + 1,
        records,
      );
      if (id !== undefined) lastId = id;
      start = newline + 1;
      newline = buffer.indexOf(NEWLINE, start);
    }
    carry = Buffer.from(buffer.subarray(start));
    base += start;
  }
  return { scannedTo: base, lastId };
}

/**
 * The index of one session file as it is now. A cached index is returned as it is while the file's size
 * and mtime are unchanged. Session files only grow, so when the size grew and the first bytes still match,
 * only the new lines are scanned. Anything else (a rewrite, a shrink, a same-size change) is scanned from the
 * first byte. Only the size at the start of the call is read.
 */
export async function indexSessionFile(file: string): Promise<FileIndex> {
  const handle = await open(file, "r");
  try {
    const { size, mtimeMs } = await handle.stat();
    const previous = cache.get(file);
    if (previous !== undefined && previous.size === size && previous.mtimeMs === mtimeMs) {
      return previous;
    }
    const head = (await readBytes(handle, 0, HEAD_FINGERPRINT_BYTES)).toString("utf8");
    const extend = previous !== undefined && size > previous.size && head.startsWith(previous.head);
    const records = extend ? new Map(previous.records) : new Map<EntryId, EntryRecord>();
    const scan = await scanRange(handle, extend ? previous.scannedTo : 0, size, records);
    const index: FileIndex = {
      size,
      mtimeMs,
      head,
      scannedTo: scan.scannedTo,
      records,
      fileLastId: scan.lastId ?? (extend ? previous.fileLastId : null),
    };
    cache.delete(file);
    cache.set(file, index);
    while (cache.size > CACHED_FILES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    return index;
  } finally {
    await handle.close();
  }
}

/** The branch from `leafId` back to its root, newest first. Undefined when the leaf is not in the file. */
export function branchPath(
  records: ReadonlyMap<EntryId, EntryRecord>,
  leafId: EntryId,
): EntryId[] | undefined {
  if (!records.has(leafId)) return undefined;
  const path: EntryId[] = [];
  const seen = new Set<EntryId>();
  let current: EntryId | null = leafId;
  while (current !== null && !seen.has(current)) {
    const record = records.get(current);
    if (record === undefined) break;
    seen.add(current);
    path.push(current);
    current = record.parentId;
  }
  return path;
}

async function readEntry(file: string, record: EntryRecord): Promise<Record<string, unknown>> {
  const text = await Bun.file(file)
    .slice(record.offset, record.offset + record.length)
    .text();
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw notFound("A session entry in this file is not an object");
  return value;
}

/** Shortens one long text to its head and tail, with a note of how much was left out. */
function cutText(
  text: string,
): { text: string; shownBytes: number; totalBytes: number } | undefined {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= OUTPUT_CUT_BYTES) return undefined;
  const head = bytes.subarray(0, OUTPUT_HEAD_BYTES).toString("utf8");
  const tail = bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES).toString("utf8");
  const omitted = bytes.length - OUTPUT_HEAD_BYTES - OUTPUT_TAIL_BYTES;
  return {
    text: `${head}\n… ${omitted} bytes left out (load the full output to see them) …\n${tail}`,
    shownBytes: OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES,
    totalBytes: bytes.length,
  };
}

/**
 * Shortens the text of a tool result or a bash execution that is over the cut limit. The message keeps
 * its place and identity; it gains `outputCut` with the bytes shown and the bytes in full.
 */
export function cutOutputs(entry: Record<string, unknown>): Record<string, unknown> {
  const message = entry.message;
  if (!isJsonObject(message)) return entry;
  let shownBytes = 0;
  let totalBytes = 0;
  let changed = false;
  const cutPart = (part: unknown): unknown => {
    if (!isJsonObject(part) || part.type !== "text" || typeof part.text !== "string") return part;
    const cut = cutText(part.text);
    if (cut === undefined) return part;
    changed = true;
    shownBytes += cut.shownBytes;
    totalBytes += cut.totalBytes;
    return { ...part, text: cut.text };
  };
  let nextMessage: Record<string, unknown> = message;
  if (message.role === "toolResult" && Array.isArray(message.content)) {
    nextMessage = { ...message, content: message.content.map(cutPart) };
  } else if (message.role === "bashExecution" && typeof message.output === "string") {
    const cut = cutText(message.output);
    if (cut !== undefined) {
      changed = true;
      shownBytes += cut.shownBytes;
      totalBytes += cut.totalBytes;
      nextMessage = { ...message, output: cut.text };
    }
  }
  if (!changed) return entry;
  return { ...entry, message: { ...nextMessage, outputCut: { shownBytes, totalBytes } } };
}

/**
 * The picture parts of one entry with their bytes: omp keeps a saved picture as `blob:sha256:<hex>`, so
 * the window reads the file and carries it as base64. A file that is missing or over the limit stays a
 * reference, and the card says the picture is not loaded.
 */
async function withImageBlobs(
  entry: Record<string, unknown>,
  blobsDir: string | undefined,
): Promise<Record<string, unknown>> {
  if (blobsDir === undefined) return entry;
  const resolved = await resolveImageBlobs(entry, blobsDir);
  return isJsonObject(resolved) ? resolved : entry;
}

async function resolveImageBlobs(value: unknown, blobsDir: string): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveImageBlobs(item, blobsDir)));
  }
  if (!isJsonObject(value)) return value;
  if (value.type === "image" && typeof value.data === "string") {
    const hex = IMAGE_BLOB_REF.exec(value.data)?.[1];
    const bytes = hex === undefined ? undefined : await readImageBlob(blobsDir, hex);
    return bytes === undefined ? value : { ...value, data: bytes.toString("base64") };
  }
  const fields = await Promise.all(
    Object.entries(value).map(
      async ([key, item]) => [key, await resolveImageBlobs(item, blobsDir)] as const,
    ),
  );
  return Object.fromEntries(fields);
}

/** A saved picture's bytes, when its file is there and no bigger than the limit; otherwise undefined. */
async function readImageBlob(blobsDir: string, hex: string): Promise<Buffer | undefined> {
  const file = join(blobsDir, hex);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > IMAGE_BLOB_MAX_BYTES) return undefined;
    return await readFile(file);
  } catch {
    return undefined;
  }
}

/** Reads the newest entries of one branch that fit the byte budget, oldest first. */
async function readEntryWindowFromEnd(file: string, request: WindowRequest): Promise<WindowResult> {
  const budget = request.byteBudget ?? DEFAULT_WINDOW_BYTES;
  const chosen: Record<string, unknown>[] = [];
  let used = 0;
  let oldestId: EntryId | null = null;
  let fileLastId: EntryId | null = null;
  let leafId: EntryId | null = request.leafId ?? null;
  let leafFound = false;
  let nextParent: EntryId | null = null;
  let hasOlder = false;

  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    for await (const line of readLinesBackwards(handle, size)) {
      const parsed = parseEntryLine(line.line, line.offset, line.length);
      if (parsed === undefined) continue;
      if (fileLastId === null) fileLastId = parsed.id;
      if (leafId === null) leafId = fileLastId;

      if (!leafFound) {
        if (parsed.id !== leafId) continue;
        leafFound = true;
      } else {
        if (nextParent === null) break;
        if (parsed.id !== nextParent) continue;
      }

      nextParent = parsed.record.parentId;
      const entry = await withImageBlobs(cutOutputs(parsed.entry), request.blobsDir);
      const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (chosen.length > 0 && used + size > budget) {
        hasOlder = true;
        break;
      }
      chosen.push(entry);
      used += size;
      oldestId = parsed.id;
      if (nextParent === null) break;
    }

    if (leafId === null) {
      return {
        leafId: null,
        fileLastId,
        entries: [],
        oldestId: null,
        hasOlder: false,
      };
    }
    if (!leafFound) throw notFound("That entry is not in this session file");
    return {
      leafId,
      fileLastId,
      entries: chosen.reverse(),
      oldestId,
      hasOlder,
    };
  } finally {
    await handle.close();
  }
}

async function readEntryWindowFromIndex(
  file: string,
  request: WindowRequest,
): Promise<WindowResult> {
  const index = await indexSessionFile(file);
  const leafId = request.leafId ?? index.fileLastId;
  if (leafId === null) {
    return {
      leafId: null,
      fileLastId: index.fileLastId,
      entries: [],
      oldestId: null,
      hasOlder: false,
    };
  }
  const path = branchPath(index.records, leafId);
  if (path === undefined) throw notFound("That entry is not in this session file");
  let from = 0;
  if (request.before !== undefined) {
    const at = path.indexOf(request.before);
    if (at === -1) throw notFound("That entry is not on this branch");
    from = at + 1;
  }
  const budget = request.byteBudget ?? DEFAULT_WINDOW_BYTES;
  const chosen: Record<string, unknown>[] = [];
  let used = 0;
  let oldestId: EntryId | null = null;
  for (let next = from; next < path.length; next += 1) {
    const id = path[next];
    const record = id === undefined ? undefined : index.records.get(id);
    if (id === undefined || record === undefined) break;
    const entry = await withImageBlobs(cutOutputs(await readEntry(file, record)), request.blobsDir);
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (chosen.length > 0 && used + size > budget) break;
    chosen.push(entry);
    used += size;
    oldestId = id;
  }
  return {
    leafId,
    fileLastId: index.fileLastId,
    entries: chosen.reverse(),
    oldestId,
    hasOlder: from + chosen.length < path.length,
  };
}

async function readFileLastId(file: string): Promise<EntryId | null> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    for await (const line of readLinesBackwards(handle, size)) {
      const parsed = parseEntryLine(line.line, line.offset, line.length);
      if (parsed !== undefined) return parsed.id;
    }
    return null;
  } finally {
    await handle.close();
  }
}

export async function readEntryWindow(file: string, request: WindowRequest): Promise<WindowResult> {
  if (request.before !== undefined) return readEntryWindowFromIndex(file, request);
  if (request.leafId === undefined) return readEntryWindowFromEnd(file, request);
  if ((await readFileLastId(file)) !== request.leafId) {
    return readEntryWindowFromIndex(file, request);
  }
  return readEntryWindowFromEnd(file, request);
}

/** One entry as omp wrote it, with no output cut. */
export async function readEntryOutput(
  file: string,
  entryId: EntryId,
): Promise<Record<string, unknown>> {
  const index = await indexSessionFile(file);
  const record = index.records.get(entryId);
  if (record === undefined) throw notFound("That entry is not in this session file");
  return readEntry(file, record);
}
