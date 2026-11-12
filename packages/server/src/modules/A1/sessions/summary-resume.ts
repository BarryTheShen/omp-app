import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import {
  createSummaryFold,
  type FoldRead,
  foldSessionFile,
  type SessionSummary,
  type SummaryFold,
  type SummaryFoldState,
  summaryFoldFrom,
} from "./summary";

/*
 * A chat that is being written grows at its end. Its summary is folded over the appended complete lines only, from the
 * state the last read kept. The state is valid while the bytes before its offset are the bytes it was read from. omp writes
 * a chat in three ways (checked against omp 18.12.6): it appends (O_APPEND); it rewrites the first 256 bytes in place when a
 * title changes, a same-length write at offset 0; and it rewrites the whole file through a temporary file and a rename, which
 * gives a new inode. It truncates only to roll back a failed append, and a failed append never leaves a complete line behind.
 * So two hashes tell the state is still valid: one over the header and the title slot, and one over the last complete line
 * before the offset. A file that fails either check, or whose inode changed, is summarized whole.
 */

/** Bytes at the start of a file that the prefix hash covers: the header and the title slot omp rewrites in place. */
export const PREFIX_HASH_BYTES = 64 * 1024;
/** The most bytes the tail hash covers: the last complete line before the offset, capped at this. */
export const TAIL_HASH_BYTES = 64 * 1024;

/** What a later read needs to carry on a summary: where the fold stopped, two hashes, and the fold's state. */
export interface ResumeState {
  /** The byte offset after the last complete line the fold has fed. */
  readonly offset: number;
  /** A hash of the first min(PREFIX_HASH_BYTES, offset) bytes. */
  readonly prefixHash: string;
  /** A hash of the last complete line before `offset` (its last TAIL_HASH_BYTES when it is longer). */
  readonly tailHash: string;
  readonly fold: SummaryFoldState;
}

/**
 * A summary and the state that resumes it. `resume` is undefined when the read could not be checked against the file (the
 * file changed while it was read): then nothing may resume from it. `resumed` is true when the read folded only the lines
 * appended since the state it resumed.
 */
export interface SummaryRead {
  readonly summary: SessionSummary;
  readonly resume?: ResumeState;
  readonly resumed: boolean;
}

/** A 128-bit SHA-256 in hex: enough to tell two byte strings apart, and short enough to keep in the cache file. */
function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/** The bytes of [start, end) that the file still holds: fewer when the file is shorter now. */
async function rangeOf(handle: fs.FileHandle, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(end - start);
  const { bytesRead } = await handle.read(buffer, 0, end - start, start);
  return buffer.subarray(0, bytesRead);
}

/**
 * The bytes the tail hash covers for `offset`: the last complete line before it, which ends at `offset - 1`, or the last
 * TAIL_HASH_BYTES of the file before `offset` when that line is longer.
 */
async function tailWindow(handle: fs.FileHandle, offset: number): Promise<Buffer> {
  if (offset === 0) return Buffer.alloc(0);
  const window = await rangeOf(handle, Math.max(0, offset - TAIL_HASH_BYTES), offset);
  if (window.length < 2) return window;
  // The byte before `offset` is the newline that ends the last complete line; the line starts after the newline before it.
  const previous = window.lastIndexOf(0x0a, window.length - 2);
  return previous === -1 ? window : window.subarray(previous + 1);
}

/**
 * Carries the summary on from `prior` when the file still holds the bytes it was read from: the header and title slot, and
 * the last complete line before the offset. Undefined when a check fails, so the caller summarizes the file whole.
 */
async function resumeFrom(
  handle: fs.FileHandle,
  sessionFile: string,
  size: number,
  prior: ResumeState,
  head: Buffer,
): Promise<SummaryRead | undefined> {
  const prefixLength = Math.min(PREFIX_HASH_BYTES, prior.offset);
  if (head.length < prefixLength) return undefined;
  if (hashOf(head.subarray(0, prefixLength)) !== prior.prefixHash) return undefined;
  if (hashOf(await tailWindow(handle, prior.offset)) !== prior.tailHash) return undefined;
  const fold = summaryFoldFrom(sessionFile, prior.fold);
  const read = await foldSessionFile(sessionFile, fold, prior.offset, size);
  return finishRead(handle, fold, read, head, true);
}

/**
 * The summary of a read and, when the file held still during it, the state that resumes it. The header and the title slot
 * are rewritten in place, so a title changed during the read would leave the state describing the old header: then the
 * state is not kept, and the next read summarizes the file whole.
 */
async function finishRead(
  handle: fs.FileHandle,
  fold: SummaryFold,
  read: FoldRead,
  head: Buffer,
  resumed: boolean,
): Promise<SummaryRead> {
  const summary = fold.result(read.rest);
  if (read.offset === 0) return { summary, resumed };
  const prefixLength = Math.min(PREFIX_HASH_BYTES, read.offset);
  const headNow = await rangeOf(handle, 0, prefixLength);
  if (headNow.length !== prefixLength || !headNow.equals(head.subarray(0, prefixLength))) {
    return { summary, resumed };
  }
  const resume: ResumeState = {
    offset: read.offset,
    prefixHash: hashOf(headNow),
    tailHash: hashOf(await tailWindow(handle, read.offset)),
    fold: fold.state(),
  };
  return { summary, resume, resumed };
}

/**
 * The summary of a session file as it is now, whose first `size` bytes are the ones the caller stat-ed. With `prior` (the
 * state an earlier read kept for this file) only the lines appended since are folded, when the checks pass; otherwise the
 * whole file is folded. Throws the file system's error if the file can't be opened or read.
 */
export async function readSummary(
  sessionFile: string,
  size: number,
  prior?: ResumeState,
): Promise<SummaryRead> {
  const handle = await fs.open(sessionFile, "r");
  try {
    const head = await rangeOf(handle, 0, Math.min(PREFIX_HASH_BYTES, size));
    if (prior !== undefined && prior.offset > 0 && prior.offset <= size) {
      const resumed = await resumeFrom(handle, sessionFile, size, prior, head);
      if (resumed !== undefined) return resumed;
    }
    const fold = createSummaryFold(sessionFile);
    const read = await foldSessionFile(sessionFile, fold, 0, size);
    return await finishRead(handle, fold, read, head, false);
  } finally {
    await handle.close();
  }
}

/**
 * The summary carried on from `prior` when the file still holds the bytes it was read from (a file that only grew), and
 * undefined when it does not, so that the caller can choose not to wait for a whole read: omp rewrites the header and the
 * title slot in place, after which a large chat can only be read whole.
 */
export async function resumeSummary(
  sessionFile: string,
  size: number,
  prior: ResumeState,
): Promise<SummaryRead | undefined> {
  if (prior.offset <= 0 || prior.offset > size) return undefined;
  const handle = await fs.open(sessionFile, "r");
  try {
    const head = await rangeOf(handle, 0, Math.min(PREFIX_HASH_BYTES, size));
    return await resumeFrom(handle, sessionFile, size, prior, head);
  } finally {
    await handle.close();
  }
}
