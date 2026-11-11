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
/** The largest saved picture a window carries: no card draws a bigger one. */
export const IMAGE_BLOB_MAX_BYTES = 4 * 1024 * 1024;
/** omp saves a picture beside the session and keeps `blob:sha256:<hex>` in place of its bytes. */
const IMAGE_BLOB_REF = /^blob:sha256:([0-9a-f]{64})$/;

const SCAN_CHUNK_BYTES = 1024 * 1024;
const HEAD_FINGERPRINT_BYTES = 256;
/** Bytes kept from just before an index's end: a rewrite that moved anything before them changes them. */
const TAIL_FINGERPRINT_BYTES = 256;
const CACHED_FILES = 4;
const NEWLINE = 10;
const CLOSE_BRACE = 0x7d;
/**
 * A character of a JSON string that is printable ASCII and neither a quote nor a backslash. The index decodes a line's
 * ends as latin1, which reads these as UTF-8 does; a line whose type or id holds any other character is parsed whole.
 */
const PLAIN = String.raw`[ !#-\[\]-~]`;
/**
 * An entry line's head as omp writes most entries, `{"type":…,"id":…,"parentId":…`: the index reads these three from it
 * and never parses the rest of the line, which can hold megabytes of tool output or pictures.
 */
const ENTRY_HEAD = new RegExp(
  String.raw`^\{"type":"(${PLAIN}*)","id":"(${PLAIN}+)","parentId":(?:null|"(${PLAIN}*)")[,}]`,
);
/** The type at the head of a line whose id comes later. */
const ENTRY_TYPE = new RegExp(String.raw`^\{"type":"(${PLAIN}*)"`);
/**
 * The end of a line omp writes with its id last (`custom` and `custom_message` entries, after their data), with the
 * `runtime` object of strings omp 18.12 added after the timestamp: only the line's own object can end there, as an
 * object inside it would leave one more brace at the end. A line in neither shape is parsed whole.
 */
const ENTRY_TAIL = new RegExp(
  `,"id":"(${PLAIN}+)","parentId":(?:null|"(${PLAIN}*)"),"timestamp":"${PLAIN}*"` +
    String.raw`(?:,"runtime":\{(?:"${PLAIN}*":"${PLAIN}*"(?:,"${PLAIN}*":"${PLAIN}*")*)?\})?\}$`,
);
/** Enough of a line's start for its head, and of its end for its tail, with ids as long as a UUID. */
const ENTRY_HEAD_BYTES = 160;
const ENTRY_TAIL_BYTES = 192;

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
  /** The bytes just before `scannedTo` when it was indexed. */
  readonly tail: Buffer;
  readonly records: ReadonlyMap<EntryId, EntryRecord>;
  readonly fileLastId: EntryId | null;
}

export interface WindowRequest {
  readonly leafId?: EntryId;
  readonly before?: EntryId;
  readonly byteBudget?: number;
  /** Also count the branch's entries older than a window read before an entry (`olderEntries`). */
  readonly countOlder?: boolean;
  /** The reader may scroll up from this window: the file's index is built meanwhile, so the earlier windows are ready. */
  readonly prepareOlder?: boolean;
  /** omp's blob folder beside the sessions: where the pictures a window's references point at are kept. */
  readonly blobsDir?: string;
}

export interface WindowResult {
  readonly leafId: EntryId | null;
  readonly fileLastId: EntryId | null;
  readonly entries: Record<string, unknown>[];
  readonly oldestId: EntryId | null;
  readonly hasOlder: boolean;
  /** The branch's entries older than the window, when asked (`countOlder`) for a window before an entry. */
  readonly olderEntries?: number;
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

/** The answer for a line in neither of omp's shapes: it is parsed whole. */
const WHOLE_LINE = Symbol("whole line");

/**
 * One line's id and parent for the index, from its head, or from its type at the head and its id at its tail, when it
 * has omp's shape; undefined for a line no branch holds, as `parseEntryLine` skips. The strings the patterns take are
 * never empty, which is all an entry id asks.
 */
function indexShape(
  head: Buffer,
  tail: Buffer,
): { id: EntryId; parentId: EntryId | null } | undefined | typeof WHOLE_LINE {
  if (tail[tail.length - 1] !== CLOSE_BRACE) return WHOLE_LINE;
  const text = head.toString("latin1");
  let type: string | undefined;
  let id: string | undefined;
  let parentId: string | undefined;
  const whole = ENTRY_HEAD.exec(text);
  if (whole !== null) {
    [, type, id, parentId] = whole;
  } else {
    type = ENTRY_TYPE.exec(text)?.[1];
    const end = type === undefined ? null : ENTRY_TAIL.exec(tail.toString("latin1"));
    if (end !== null) [, id, parentId] = end;
  }
  if (type === undefined || id === undefined) return WHOLE_LINE;
  if (type === "session" || type === "title") return undefined;
  return {
    id: id as EntryId,
    parentId: parentId === undefined || parentId === "" ? null : (parentId as EntryId),
  };
}

/** One line's id and parent from the whole line, read again from the file. `length` counts the newline. */
async function indexWhole(
  handle: FileHandle,
  offset: number,
  length: number,
): Promise<{ id: EntryId; parentId: EntryId | null } | undefined> {
  const parsed = parseEntryLine(await readBytes(handle, offset, length - 1), offset, length);
  return parsed === undefined ? undefined : { id: parsed.id, parentId: parsed.record.parentId };
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

const NO_BYTES = Buffer.alloc(0);

/**
 * Scans the complete lines from `from` to `to`; a partial last line is left for the next scan. Of a line only its first
 * and last bytes are looked at, so a line of megabytes (a tool's output, a picture) is never copied whole.
 */
async function scanRange(
  handle: FileHandle,
  from: number,
  to: number,
  records: Map<EntryId, EntryRecord>,
): Promise<{ scannedTo: number; lastId: EntryId | undefined }> {
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let position = from;
  // The line being read: where it starts, and its first and last bytes from earlier chunks.
  let lineStart = from;
  let head = NO_BYTES;
  let tail = NO_BYTES;
  let lastId: EntryId | undefined;
  while (position < to) {
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(SCAN_CHUNK_BYTES, to - position),
      position,
    );
    if (bytesRead === 0) break;
    const view = chunk.subarray(0, bytesRead);
    let start = 0;
    let newline = view.indexOf(NEWLINE, start);
    while (newline !== -1) {
      const own = view.subarray(start, newline);
      const lineHead =
        head.length === 0
          ? own.subarray(0, ENTRY_HEAD_BYTES)
          : Buffer.concat([head, own.subarray(0, Math.max(0, ENTRY_HEAD_BYTES - head.length))]);
      const lineTail =
        tail.length === 0 || own.length >= ENTRY_TAIL_BYTES
          ? own.subarray(Math.max(0, own.length - ENTRY_TAIL_BYTES))
          : Buffer.concat([tail, own]).subarray(-ENTRY_TAIL_BYTES);
      const length = position + newline + 1 - lineStart;
      const shaped = indexShape(lineHead, lineTail);
      const indexed = shaped === WHOLE_LINE ? await indexWhole(handle, lineStart, length) : shaped;
      if (indexed !== undefined) {
        records.set(indexed.id, { parentId: indexed.parentId, offset: lineStart, length });
        lastId = indexed.id;
      }
      lineStart = position + newline + 1;
      head = NO_BYTES;
      tail = NO_BYTES;
      start = newline + 1;
      newline = view.indexOf(NEWLINE, start);
    }
    if (start < bytesRead) {
      // The line goes on in the next chunk: its first and last bytes are copied, since the chunk is read into again.
      const rest = view.subarray(start);
      if (head.length < ENTRY_HEAD_BYTES) {
        head = Buffer.concat([head, rest.subarray(0, ENTRY_HEAD_BYTES - head.length)]);
      }
      tail = Buffer.from(
        rest.length >= ENTRY_TAIL_BYTES
          ? rest.subarray(rest.length - ENTRY_TAIL_BYTES)
          : Buffer.concat([tail, rest]).subarray(-ENTRY_TAIL_BYTES),
      );
    }
    position += bytesRead;
  }
  return { scannedTo: lineStart, lastId };
}

/** Index builds running now, one per file: a read and the opening's own build share one scan. */
const building = new Map<string, Promise<FileIndex>>();

/**
 * The index of one session file as it is now. A cached index is returned as it is while the file's size and mtime are
 * unchanged. A longer file whose first bytes, and whose bytes just before the indexed end, are unchanged had lines
 * appended, so only the new lines are scanned. Anything else is scanned from the first byte: omp also rewrites session
 * files in place (its maintenance's `rewriteEntries`), which moves every line after the first change. `fresh` asks for
 * that full scan whatever the cache holds. A build already running for the file is waited for, then the cache checked.
 */
export function indexSessionFile(file: string, fresh = false): Promise<FileIndex> {
  const running = building.get(file);
  if (running !== undefined && !fresh) {
    return running.then(
      () => buildIndex(file, false),
      () => buildIndex(file, false),
    );
  }
  const job = buildIndex(file, fresh);
  building.set(file, job);
  const done = (): void => {
    if (building.get(file) === job) building.delete(file);
  };
  job.then(done, done);
  return job;
}

/** One index build; only the size at its start is read. */
async function buildIndex(file: string, fresh: boolean): Promise<FileIndex> {
  const handle = await open(file, "r");
  try {
    const { size, mtimeMs } = await handle.stat();
    const previous = fresh ? undefined : cache.get(file);
    if (previous !== undefined && previous.size === size && previous.mtimeMs === mtimeMs) {
      return previous;
    }
    const head = (await readBytes(handle, 0, HEAD_FINGERPRINT_BYTES)).toString("utf8");
    const extend =
      previous !== undefined &&
      size > previous.size &&
      head.startsWith(previous.head) &&
      (
        await readBytes(handle, previous.scannedTo - previous.tail.length, previous.tail.length)
      ).equals(previous.tail);
    const records = extend ? new Map(previous.records) : new Map<EntryId, EntryRecord>();
    const scan = await scanRange(handle, extend ? previous.scannedTo : 0, size, records);
    const tailLength = Math.min(TAIL_FINGERPRINT_BYTES, scan.scannedTo);
    const index: FileIndex = {
      size,
      mtimeMs,
      head,
      scannedTo: scan.scannedTo,
      tail: await readBytes(handle, scan.scannedTo - tailLength, tailLength),
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

/**
 * The last branch a window was read along, kept with its index: a reader paging up reads along one branch, and walking a
 * long chat's branch again for each window took tens of milliseconds. An index is current only while its file is
 * unchanged, so its branches are too.
 */
const branches = new WeakMap<FileIndex, { readonly leafId: EntryId; readonly path: EntryId[] }>();

function branchOf(index: FileIndex, leafId: EntryId): EntryId[] | undefined {
  const kept = branches.get(index);
  if (kept?.leafId === leafId) return kept.path;
  const path = branchPath(index.records, leafId);
  if (path !== undefined) branches.set(index, { leafId, path });
  return path;
}

/** The index no longer matches the file: omp rewrote it in place after it was indexed. */
class StaleIndex extends Error {}

/**
 * Reads entry `id` where the index puts it. The line there must be that entry with that parent; anything else means the
 * file was rewritten after it was indexed.
 */
async function readEntry(
  file: string,
  id: EntryId,
  record: EntryRecord,
): Promise<Record<string, unknown>> {
  const text = await Bun.file(file)
    .slice(record.offset, record.offset + record.length)
    .text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StaleIndex();
  }
  if (!isJsonObject(value) || value.id !== id) throw new StaleIndex();
  const parentId =
    typeof value.parentId === "string" && value.parentId.length > 0 ? value.parentId : null;
  if (parentId !== record.parentId) throw new StaleIndex();
  return value;
}

/**
 * Runs `read` on the file's index. A read that finds the index stale indexes the file again from its first byte and
 * runs once more; a file rewritten again meanwhile is refused for now, to be asked again.
 */
async function withIndex<T>(file: string, read: (index: FileIndex) => Promise<T>): Promise<T> {
  try {
    return await read(await indexSessionFile(file));
  } catch (error) {
    if (!(error instanceof StaleIndex)) throw error;
  }
  try {
    return await read(await indexSessionFile(file, true));
  } catch (error) {
    if (!(error instanceof StaleIndex)) throw error;
    throw new AppFailure({
      code: "unavailable",
      message: "The session file changed while it was read; try again.",
      retryable: true,
    });
  }
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
  return withIndex(file, async (index) => {
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
    const path = branchOf(index, leafId);
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
      const entry = await withImageBlobs(
        cutOutputs(await readEntry(file, id, record)),
        request.blobsDir,
      );
      const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (chosen.length > 0 && used + size > budget) break;
      chosen.push(entry);
      used += size;
      oldestId = id;
    }
    const olderEntries = path.length - (from + chosen.length);
    return {
      leafId,
      fileLastId: index.fileLastId,
      entries: chosen.reverse(),
      oldestId,
      hasOlder: olderEntries > 0,
      ...(request.countOlder === true ? { olderEntries } : {}),
    };
  });
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
  if (request.leafId !== undefined && (await readFileLastId(file)) !== request.leafId) {
    return readEntryWindowFromIndex(file, request);
  }
  const window = await readEntryWindowFromEnd(file, request);
  // The first window comes from the file's end; the earlier ones need the file's index and the branch walked in it,
  // which a long chat takes a moment to build: asked for, they are made now, so scrolling up finds them ready.
  if (request.prepareOlder === true && window.hasOlder && window.leafId !== null) {
    const leafId = window.leafId;
    indexSessionFile(file)
      .then((index) => branchOf(index, leafId))
      .catch(() => undefined);
  }
  return window;
}

/** One entry as omp wrote it, with no output cut. */
export async function readEntryOutput(
  file: string,
  entryId: EntryId,
): Promise<Record<string, unknown>> {
  return withIndex(file, async (index) => {
    const record = index.records.get(entryId);
    if (record === undefined) throw notFound("That entry is not in this session file");
    return readEntry(file, entryId, record);
  });
}
