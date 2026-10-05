import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  AppFailure,
  type AttachmentBlobDeleteArgs,
  type AttachmentBlobGetArgs,
  type AttachmentBlobGetResult,
  type AttachmentBlobListResult,
  type AttachmentBlobPutArgs,
  type AttachmentBlobPutResult,
  type AttachmentRef,
  MAX_ATTACHMENT_BYTES,
} from "@omp-app/contracts";
import {
  compareAndSwapFile,
  ensureAppDataDir,
  readFileSnapshot,
  resolveAppDataDir,
  writeFileAtomic,
} from "../fs";

const ATTACHMENTS_DIRECTORY = "attachments";
const META_EXTENSION = ".json";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ALLOWED_MEDIA = new Set(["text/plain", "text/markdown"]);

export interface AttachmentStoreOptions {
  readonly appDataDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly maxTotalBytes?: number;
  /** Fresh DraftStore-backed references used for every cleanup/eviction pass. */
  readonly referencedAttachments: () => Promise<readonly AttachmentRef[]>;
}

interface StoredMeta {
  readonly ref: AttachmentRef;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

function failure(
  code: "invalid_args" | "conflict" | "not_found" | "permission" | "internal" | "unavailable",
  message: string,
  retryable = false,
): AppFailure {
  return new AppFailure({
    code,
    message,
    retryable,
    ...(code === "unavailable" ? { capability: "host.attachments" as const } : {}),
  });
}

function unavailable(message: string): AppFailure {
  return failure("unavailable", message);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function toFailure(error: unknown, operation: string): AppFailure {
  if (error instanceof AppFailure) return error;
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM")
    return failure("permission", `Cannot ${operation}: permission denied.`);
  if (code === "ENOENT" || code === "ENOTDIR")
    return failure("not_found", `Cannot ${operation}: attachment not found.`);
  return failure("internal", `Cannot ${operation}.`);
}

function validateId(value: string): string {
  if (
    !value ||
    value !== basename(value) ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw failure("invalid_args", "Attachment id is invalid.");
  }
  return value;
}

function validateMediaType(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized.startsWith("image/") || ALLOWED_MEDIA.has(normalized)) return normalized;
  throw failure("invalid_args", "Attachment media type is not allowed.");
}

function decodeBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw failure("invalid_args", "Attachment bytes are not valid base64.");
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value)
    throw failure("invalid_args", "Attachment bytes are not valid base64.");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw failure("invalid_args", `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit.`);
  }
  return bytes;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashFromRef(ref: AttachmentRef): string {
  if (typeof ref.id === "string" && HASH_PATTERN.test(ref.id)) return ref.id;
  const uri = typeof ref.uri === "string" ? ref.uri : `attachment://${ref.id}`;
  const prefix = "attachment://";
  if (!uri.startsWith(prefix))
    throw failure("invalid_args", "Attachment reference URI is invalid.");
  const hash = uri.slice(prefix.length);
  if (!HASH_PATTERN.test(hash))
    throw failure("invalid_args", "Attachment reference id is invalid.");
  return hash;
}

function asRef(value: unknown): AttachmentRef | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.mediaType !== "string"
  )
    return null;
  return {
    id: raw.id,
    name: raw.name,
    mediaType: raw.mediaType,
    ...(typeof raw.sizeBytes === "number" ? { sizeBytes: raw.sizeBytes } : {}),
    ...(typeof raw.uri === "string" ? { uri: raw.uri } : {}),
  };
}

function resolveAppDataRoot(options: AttachmentStoreOptions): string {
  const env =
    options.appDataDir === undefined
      ? options.env
      : { ...(options.env ?? {}), OMP_APP_DATA_DIR: options.appDataDir };
  return resolveAppDataDir({ env, homeDir: options.homeDir, cwd: options.cwd });
}

/**
 * App-owned content-addressed attachment blobs. U2.3's default is 10 MiB, but the app protocol's
 * v1 physical frame limit is 1,048,576 bytes (`omp-rpc` fixtures and FrameDecoder); base64 plus JSON
 * overhead makes `MAX_ATTACHMENT_BYTES` in C0 a conservative 700 KiB. Blobs are written with A1.2's
 * atomic writer (0600), while metadata keeps safe refs and creation order for bounded eviction.
 */
export class AttachmentStoreService {
  readonly appDataDir: string;
  readonly attachmentsDir: string;
  readonly #options: AttachmentStoreOptions;
  #disposed = false;

  constructor(options: AttachmentStoreOptions) {
    this.#options = options;
    this.appDataDir = resolveAppDataRoot(options);
    this.attachmentsDir = resolve(this.appDataDir, ATTACHMENTS_DIRECTORY);
  }

  async put(args: AttachmentBlobPutArgs): Promise<AttachmentBlobPutResult> {
    this.assertOpen();
    validateId(args.id);
    const mediaType = validateMediaType(args.mediaType);
    const bytes = decodeBase64(args.bytes);
    const hash = hashBytes(bytes);
    const blobPath = this.blobPath(hash);
    await ensureAppDataDir(this.appDataDir);
    await fs.mkdir(this.attachmentsDir, { recursive: true, mode: 0o700 });
    const existing = await readFileSnapshot(blobPath);
    if (!existing.exists) {
      try {
        await compareAndSwapFile(blobPath, bytes, null);
      } catch (error) {
        throw toFailure(error, "write attachment");
      }
    } else if (existing.hash !== hash) {
      throw failure("conflict", "Attachment content changed while storing.", true);
    }
    const ref: AttachmentRef = {
      id: hash,
      name: args.name,
      mediaType,
      sizeBytes: bytes.byteLength,
      uri: `attachment://${hash}`,
    };
    const meta: StoredMeta = {
      ref,
      sizeBytes: bytes.byteLength,
      createdAt: new Date().toISOString(),
    };
    try {
      await writeFileAtomic(this.metaPath(hash), JSON.stringify(meta));
    } catch (error) {
      throw toFailure(error, "write attachment metadata");
    }
    await this.evictIfNeeded();
    if (!(await this.fileExists(blobPath))) {
      throw unavailable("Attachment storage full: all remaining blobs are referenced.");
    }
    return { ref };
  }

  async get(args: AttachmentBlobGetArgs): Promise<AttachmentBlobGetResult> {
    this.assertOpen();
    const hash = hashFromRef(args.ref);
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(this.blobPath(hash));
    } catch (error) {
      throw toFailure(error, "read attachment");
    }
    if (bytes.byteLength === 0) throw failure("not_found", "Attachment blob was not found.");
    return { ref: args.ref, bytes: Buffer.from(bytes).toString("base64") };
  }

  async delete(args: AttachmentBlobDeleteArgs): Promise<{ deleted: true }> {
    this.assertOpen();
    const hash = hashFromRef(args.ref);
    try {
      await fs.rm(this.blobPath(hash), { force: false });
      await fs.rm(this.metaPath(hash), { force: true });
    } catch (error) {
      throw toFailure(error, "delete attachment");
    }
    return { deleted: true };
  }

  async list(): Promise<AttachmentBlobListResult> {
    this.assertOpen();
    await ensureAppDataDir(this.appDataDir);
    let entries: string[];
    try {
      entries = await fs.readdir(this.attachmentsDir);
    } catch (error) {
      throw toFailure(error, "list attachments");
    }
    const refs: AttachmentRef[] = [];
    for (const entry of entries.filter((name) => name.endsWith(META_EXTENSION))) {
      try {
        const value = JSON.parse(await fs.readFile(join(this.attachmentsDir, entry), "utf8"));
        const ref = asRef((value as Record<string, unknown>).ref);
        if (ref) refs.push(ref);
      } catch {
        // Corrupt metadata is not exposed; the corresponding blob is removed by cleanup.
      }
    }
    return { refs };
  }

  /** Removes old unreferenced or over-cap blobs using a fresh DraftStore reference snapshot. */
  async cleanup(options: { readonly orphanAgeMs?: number } = {}): Promise<void> {
    this.assertOpen();
    await this.evictIfNeeded(options.orphanAgeMs);
  }

  dispose(): void {
    this.#disposed = true;
  }

  private assertOpen(): void {
    if (this.#disposed) throw unavailable("Attachment store is closed.");
  }

  private blobPath(hash: string): string {
    if (!HASH_PATTERN.test(hash)) throw failure("invalid_args", "Attachment blob id is invalid.");
    return join(this.attachmentsDir, `${hash}.blob`);
  }

  private metaPath(hash: string): string {
    return join(this.attachmentsDir, `${hash}.json`);
  }

  private async evictIfNeeded(orphanAgeMs?: number): Promise<void> {
    const max = Math.max(1, Math.floor(this.#options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES));
    const referenced = new Set<string>();
    let malformedReference = false;
    for (const ref of await this.#options.referencedAttachments()) {
      try {
        referenced.add(hashFromRef(ref));
      } catch {
        malformedReference = true;
      }
    }
    await fs.mkdir(this.attachmentsDir, { recursive: true, mode: 0o700 });
    let entries: string[];
    try {
      entries = await fs.readdir(this.attachmentsDir);
    } catch (error) {
      throw toFailure(error, "evict attachments");
    }
    const blobs: Array<{ hash: string; size: number; createdAt: number }> = [];
    let total = 0;
    for (const entry of entries.filter((name) => name.endsWith(".blob"))) {
      const hash = entry.slice(0, -5);
      if (!HASH_PATTERN.test(hash)) continue;
      const stat = await fs.stat(join(this.attachmentsDir, entry));
      const meta = await this.readMeta(hash);
      const createdAtValue = meta ? Date.parse(meta.createdAt) : Number.NaN;
      const createdAt = Number.isFinite(createdAtValue)
        ? Math.min(createdAtValue, stat.mtimeMs)
        : stat.mtimeMs;
      blobs.push({ hash, size: stat.size, createdAt });
      total += stat.size;
    }
    blobs.sort((left, right) => left.createdAt - right.createdAt);
    const now = Date.now();
    for (const blob of blobs) {
      const isReferenced = malformedReference || referenced.has(blob.hash);
      const isOldOrphan =
        orphanAgeMs !== undefined && !isReferenced && now - blob.createdAt >= orphanAgeMs;
      if (!isOldOrphan && (total <= max || isReferenced)) continue;
      await fs.rm(this.blobPath(blob.hash), { force: true });
      await fs.rm(this.metaPath(blob.hash), { force: true });
      total -= blob.size;
    }
    if (total > max)
      throw unavailable("Attachment storage full: all remaining blobs are referenced.");
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.stat(path);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw toFailure(error, "check attachment storage");
    }
  }

  private async readMeta(hash: string): Promise<StoredMeta | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.metaPath(hash), "utf8"));
      const ref = asRef((value as Record<string, unknown>).ref);
      const sizeBytes = (value as Record<string, unknown>).sizeBytes;
      const createdAt = (value as Record<string, unknown>).createdAt;
      if (!ref || typeof sizeBytes !== "number" || typeof createdAt !== "string") return null;
      return { ref, sizeBytes, createdAt };
    } catch {
      return null;
    }
  }
}

export function createAttachmentStore(options: AttachmentStoreOptions): AttachmentStoreService {
  return new AttachmentStoreService(options);
}
