/**
 * Atomic publish is serialized by an in-process path mutex. The lock file
 * coordinates only app-owned writer processes; omp's own writers do not use it.
 * Consequently, the CAS hash check protects against omp edits, but a small
 * check-to-rename race remains. Breaking stale locks is best-effort.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type Dirent,
  existsSync,
  promises as fs,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { type AppError, AppFailure } from "@omp-app/contracts";

const ATOMIC_TEMP_FILE_PATTERN = /^\.omp-atomic-[a-f0-9]{32}\.tmp$/;
const ATOMIC_LOCK_FILE_PATTERN = /^\.omp-atomic-lock-[a-f0-9]{32}\.lock$/;

/** A temp or lock file of this writer's, beside the file it writes: not the person's file (the Files panel hides it). */
export function isAtomicWriteArtifact(name: string): boolean {
  return ATOMIC_TEMP_FILE_PATTERN.test(name) || ATOMIC_LOCK_FILE_PATTERN.test(name);
}
const SELF_WRITE_RETENTION_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 15_000;
/** Attempts to remove a lock file at release; a file that stays is stale to this process (see `lockOwnerIsStale`). */
const LOCK_RELEASE_ATTEMPTS = 3;
/**
 * A temp file last written this long ago was left by a writer that died: a live writer renames its file moments
 * after writing it. A sweep also never removes a temp file this process is still writing (`temporaryFilesInUse`).
 */
const ATOMIC_TEMP_STALE_MS = 60_000;
/** The names of the temp files this process is writing and has not yet renamed or removed. */
const temporaryFilesInUse = new Set<string>();
/** The lock files this process holds: from their create until the release that removes them has run. */
const lockFilesInUse = new Set<string>();

export type AtomicFileContent = string | Uint8Array;
export type ExpectedFileHash = string | null;

export const NO_FILE: ExpectedFileHash = null;

export interface FileSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly content: string | null;
  readonly hash: string | null;
}

export interface AtomicWriteResult {
  readonly path: string;
  readonly hash: string;
}

export interface AtomicWriteOptions {
  /** Omit for an unconditional write; null means create only when no file exists. */
  readonly expectedHash?: ExpectedFileHash;
  /** Fault-injection seam used by crash-recovery tests, called after fsync and before rename. */
  readonly beforeRename?: () => void | Promise<void>;
}

const pathLocks = new Map<string, Promise<void>>();
const selfWriteConsumers = new Map<string, number>();
const selfWriteHashes = new Map<string, Map<string, number>>();

function hasErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === code;
}

function appError(code: AppError["code"], message: string, retryable: boolean): AppFailure {
  return new AppFailure({ code, message, retryable });
}

function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashContent(content: AtomicFileContent): string {
  if (typeof content === "string") {
    return hashBytes(Buffer.from(content, "utf8"));
  }
  return hashBytes(content);
}

async function withPathLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path);
  let release!: () => void;
  const lock = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  pathLocks.set(path, lock);
  if (previous) {
    await previous;
  }
  try {
    return await operation();
  } finally {
    release();
    if (pathLocks.get(path) === lock) {
      pathLocks.delete(path);
    }
  }
}

interface FileLock {
  readonly path: string;
}

function lockPathFor(filePath: string): string {
  const lockHash = hashContent(filePath).slice(0, 32);
  return resolve(dirname(filePath), `.omp-atomic-lock-${lockHash}.lock`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

/**
 * Whether the process that wrote a lock file has gone. This process's own lock is held only while an operation of
 * this process holds it, so one it still names after that operation has released it is stale. Another process's
 * lock is held for as long as that process runs.
 */
function lockOwnerIsStale(lockPath: string, pid: number): boolean {
  if (pid === process.pid) return !lockFilesInUse.has(lockPath);
  return !processIsAlive(pid);
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  const pid = Number.parseInt(contents.trim(), 10);
  if (Number.isInteger(pid) && pid > 0) return lockOwnerIsStale(lockPath, pid);
  try {
    const metadata = await fs.stat(lockPath);
    return Date.now() - metadata.mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}

async function waitForLock(): Promise<void> {
  await new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, 10);
  });
}

async function acquireFileLock(filePath: string): Promise<FileLock> {
  const lockPath = lockPathFor(filePath);
  const startedAt = Date.now();
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (await lockIsStale(lockPath)) {
        await unlinkTempFile(lockPath);
        continue;
      }
      if (Date.now() - startedAt > LOCK_WAIT_TIMEOUT_MS) {
        throw appError("conflict", "Cannot write: another writer still holds the file.", true);
      }
      await waitForLock();
      continue;
    }
    // Marked before the pid is written, so a sweep that reads the pid already finds the lock held.
    lockFilesInUse.add(lockPath);
    try {
      try {
        await handle.writeFile(`${process.pid}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      await releaseFileLock({ path: lockPath });
      throw error;
    }
    return { path: lockPath };
  }
}

/**
 * Removes a lock file this process holds, retrying a refused removal. The lock stops counting as held whatever the
 * outcome: a file that stays is then stale to this process (see `lockOwnerIsStale`), so the next save takes it over.
 */
async function releaseFileLock(lock: FileLock): Promise<void> {
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await unlinkTempFile(lock.path);
        return;
      } catch (error) {
        if (attempt === LOCK_RELEASE_ATTEMPTS) throw error;
        await waitForLock();
      }
    }
  } finally {
    lockFilesInUse.delete(lock.path);
  }
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireFileLock(path);
  try {
    return await operation();
  } finally {
    await releaseFileLock(lock);
  }
}

function rememberSelfWrite(path: string, hash: string): void {
  if (!selfWriteConsumers.has(path)) return;
  const now = Date.now();
  let hashes = selfWriteHashes.get(path);
  if (!hashes) {
    hashes = new Map<string, number>();
    selfWriteHashes.set(path, hashes);
  }
  for (const [knownHash, timestamp] of hashes) {
    if (now - timestamp > SELF_WRITE_RETENTION_MS) {
      hashes.delete(knownHash);
    }
  }
  hashes.set(hash, now);
}

/** Internal watcher seam: registers one watcher that can consume this process's writes. */
export function registerSelfWriteConsumer(path: string): () => void {
  const count = selfWriteConsumers.get(path) ?? 0;
  selfWriteConsumers.set(path, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (selfWriteConsumers.get(path) ?? 1) - 1;
    if (remaining <= 0) {
      selfWriteConsumers.delete(path);
      selfWriteHashes.delete(path);
    } else {
      selfWriteConsumers.set(path, remaining);
    }
  };
}

/** Internal watcher seam: consumes any pending self-write marker for an observed hash. */
export function consumeSelfWrite(path: string, hash: string | null): boolean {
  const hashes = selfWriteHashes.get(path);
  if (!hashes) return false;
  const matched = hash !== null && hashes.has(hash);
  selfWriteHashes.delete(path);
  return matched;
}

export function readFileHashSync(filePath: string): string | null {
  const path = resolve(filePath);
  try {
    return hashBytes(readFileSync(path));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function readFileHash(filePath: string): Promise<string | null> {
  const path = resolve(filePath);
  try {
    return hashBytes(await fs.readFile(path));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function readFileSnapshot(filePath: string): Promise<FileSnapshot> {
  const path = resolve(filePath);
  try {
    const bytes = await fs.readFile(path);
    return {
      path,
      exists: true,
      content: bytes.toString("utf8"),
      hash: hashBytes(bytes),
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { path, exists: false, content: null, hash: null };
    }
    throw error;
  }
}

/** The file as it is at this moment, read synchronously: the same snapshot as readFileSnapshot, for a baseline taken in the same step as a watch. */
export function readFileSnapshotSync(filePath: string): FileSnapshot {
  const path = resolve(filePath);
  try {
    const bytes = readFileSync(path);
    return {
      path,
      exists: true,
      content: bytes.toString("utf8"),
      hash: hashBytes(bytes),
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { path, exists: false, content: null, hash: null };
    }
    throw error;
  }
}

interface TemporaryFile {
  readonly path: string;
  readonly handle: FileHandle;
}

async function writeTempFile(
  directory: string,
  content: AtomicFileContent,
): Promise<TemporaryFile> {
  let handle: FileHandle;
  let path: string;
  for (;;) {
    path = resolve(directory, `.omp-atomic-${randomBytes(16).toString("hex")}.tmp`);
    try {
      handle = await fs.open(path, "wx", 0o600);
      break;
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) continue;
      throw error;
    }
  }
  const name = basename(path);
  temporaryFilesInUse.add(name);
  try {
    await handle.writeFile(content);
    await handle.chmod(0o600);
    await handle.sync();
    return { path, handle };
  } catch (error) {
    try {
      await handle.close();
      await unlinkTempFile(path);
    } finally {
      temporaryFilesInUse.delete(name);
    }
    throw error;
  }
}

/** Puts a folder's entries on disk, so a file renamed into it is there after a crash. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkTempFile(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

export async function writeFileAtomic(
  filePath: string,
  content: AtomicFileContent,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const path = resolve(filePath);
  const directory = dirname(path);
  const hash = hashContent(content);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return withPathLock(path, () =>
    withFileLock(path, async () => {
      if (options.expectedHash !== undefined) {
        const currentHash = await readFileHash(path);
        if (currentHash !== options.expectedHash) {
          const expected =
            options.expectedHash === null ? "no file" : "the previously read content";
          throw appError(
            "conflict",
            `Cannot write: expected ${expected}, but the file changed.`,
            true,
          );
        }
      }

      const temporary = await writeTempFile(directory, content);
      let closed = false;
      try {
        await temporary.handle.close();
        closed = true;
        if (options.beforeRename) {
          await options.beforeRename();
        }
        await fs.rename(temporary.path, path);
        rememberSelfWrite(path, hash);
        await syncDirectory(directory);
        return { path, hash };
      } catch (error) {
        if (!closed) {
          await temporary.handle.close();
        }
        await unlinkTempFile(temporary.path);
        throw error;
      } finally {
        temporaryFilesInUse.delete(basename(temporary.path));
      }
    }),
  );
}

export async function compareAndSwapFile(
  filePath: string,
  content: AtomicFileContent,
  expectedHash: ExpectedFileHash,
  options: Omit<AtomicWriteOptions, "expectedHash"> = {},
): Promise<AtomicWriteResult> {
  return writeFileAtomic(filePath, content, { ...options, expectedHash });
}

async function cleanupStaleLock(lockPath: string): Promise<void> {
  if (await lockIsStale(lockPath)) {
    await unlinkTempFile(lockPath);
  }
}

function lockIsStaleSync(lockPath: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  const pid = Number.parseInt(contents.trim(), 10);
  if (Number.isInteger(pid) && pid > 0) return lockOwnerIsStale(lockPath, pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}

/**
 * Removes a temp file that no writer can still be using: not one this process is writing, and not one written
 * within the last ATOMIC_TEMP_STALE_MS.
 */
async function removeStaleTempFile(path: string, name: string): Promise<void> {
  if (temporaryFilesInUse.has(name)) return;
  let modifiedMs: number;
  try {
    modifiedMs = (await fs.stat(path)).mtimeMs;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (Date.now() - modifiedMs > ATOMIC_TEMP_STALE_MS) await unlinkTempFile(path);
}

/**
 * Removes the stale temp and lock files under `directory`. A folder this process cannot list holds nothing this sweep
 * can remove, so it is skipped: one locked folder must not fail the write or the chat start that runs this sweep.
 */
export async function cleanupAtomicTempFiles(directory: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      hasErrorCode(error, "ENOENT") ||
      hasErrorCode(error, "EACCES") ||
      hasErrorCode(error, "EPERM")
    ) {
      return;
    }
    throw error;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await cleanupAtomicTempFiles(entryPath);
      } else if (ATOMIC_TEMP_FILE_PATTERN.test(entry.name)) {
        await removeStaleTempFile(entryPath, entry.name);
      } else if (ATOMIC_LOCK_FILE_PATTERN.test(entry.name)) {
        await cleanupStaleLock(entryPath);
      }
    }),
  );
}

function removeStaleTempFileSync(path: string, name: string): void {
  if (temporaryFilesInUse.has(name)) return;
  let modifiedMs: number;
  try {
    modifiedMs = statSync(path).mtimeMs;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (Date.now() - modifiedMs <= ATOMIC_TEMP_STALE_MS) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

export function cleanupAtomicTempFilesSync(directory: string): void {
  if (!existsSync(directory)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (
      hasErrorCode(error, "ENOENT") ||
      hasErrorCode(error, "EACCES") ||
      hasErrorCode(error, "EPERM")
    ) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      cleanupAtomicTempFilesSync(entryPath);
    } else if (ATOMIC_TEMP_FILE_PATTERN.test(entry.name)) {
      removeStaleTempFileSync(entryPath, entry.name);
    } else if (ATOMIC_LOCK_FILE_PATTERN.test(entry.name) && lockIsStaleSync(entryPath)) {
      try {
        unlinkSync(entryPath);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
    }
  }
}
