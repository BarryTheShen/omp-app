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
import { dirname, resolve } from "node:path";
import { type AppError, AppFailure } from "@omp-app/contracts";

const ATOMIC_TEMP_FILE_PATTERN = /^\.omp-atomic-[a-f0-9]{32}\.tmp$/;
const ATOMIC_LOCK_FILE_PATTERN = /^\.omp-atomic-lock-[a-f0-9]{32}\.lock$/;
const SELF_WRITE_RETENTION_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 15_000;

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

async function lockIsStale(lockPath: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  const pid = Number.parseInt(contents.trim(), 10);
  if (Number.isInteger(pid) && pid > 0) return !processIsAlive(pid);
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
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        await handle.sync();
      } catch (error) {
        await handle.close();
        await unlinkTempFile(lockPath);
        throw error;
      }
      await handle.close();
      return { path: lockPath };
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
    }
  }
}

async function releaseFileLock(lock: FileLock): Promise<void> {
  await unlinkTempFile(lock.path);
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
  try {
    await handle.writeFile(content);
    await handle.chmod(0o600);
    await handle.sync();
    return { path, handle };
  } catch (error) {
    await handle.close();
    await unlinkTempFile(path);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
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
  if (Number.isInteger(pid) && pid > 0) return !processIsAlive(pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}

export async function cleanupAtomicTempFiles(directory: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await cleanupAtomicTempFiles(entryPath);
      } else if (ATOMIC_TEMP_FILE_PATTERN.test(entry.name)) {
        await unlinkTempFile(entryPath);
      } else if (ATOMIC_LOCK_FILE_PATTERN.test(entry.name)) {
        await cleanupStaleLock(entryPath);
      }
    }),
  );
}

export function cleanupAtomicTempFilesSync(directory: string): void {
  if (!existsSync(directory)) return;
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      cleanupAtomicTempFilesSync(entryPath);
    } else if (ATOMIC_TEMP_FILE_PATTERN.test(entry.name)) {
      try {
        unlinkSync(entryPath);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
    } else if (ATOMIC_LOCK_FILE_PATTERN.test(entry.name) && lockIsStaleSync(entryPath)) {
      try {
        unlinkSync(entryPath);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
    }
  }
}
