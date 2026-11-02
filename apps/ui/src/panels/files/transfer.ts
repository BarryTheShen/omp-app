import {
  type FileHash,
  type FolderPath,
  MAX_FILE_CHUNK_BYTES,
  type PortClient,
  type WorkspaceFilesPort,
  type WorkspaceRelativePath,
} from "@omp-app/contracts";

/** The Files port as a page calls it. */
export type FilesClient = PortClient<typeof WorkspaceFilesPort>;

/** Base64 of bytes, in slices so a big file never makes one huge argument list. */
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface ReadFile {
  readonly bytes: Uint8Array;
  /** The whole file's size; more than `bytes` when only a part was asked for. */
  readonly size: number;
  readonly modifiedMs: number;
}

/** Starts over this many times when the file keeps changing while it is read, then gives up. */
const READ_ATTEMPTS = 3;

/**
 * A file's bytes, read in chunks up to `limit` bytes (all of them by default). When the file's size or time changes
 * between chunks it was written meanwhile, and the read starts over, so the bytes are one version of the file.
 */
export async function readFileBytes(
  files: FilesClient,
  folder: FolderPath,
  path: WorkspaceRelativePath,
  limit = Number.POSITIVE_INFINITY,
): Promise<ReadFile> {
  for (let attempt = 1; ; attempt += 1) {
    const first = await files.read({ folder, path, offset: 0, length: MAX_FILE_CHUNK_BYTES });
    const total = Math.min(first.size, limit);
    const bytes = new Uint8Array(total);
    let filled = 0;
    let chunk = fromBase64(first.bytes);
    let changed = false;
    for (;;) {
      const part = chunk.subarray(0, total - filled);
      bytes.set(part, filled);
      filled += part.length;
      if (filled >= total || chunk.length === 0) break;
      const next = await files.read({
        folder,
        path,
        offset: filled,
        length: Math.min(MAX_FILE_CHUNK_BYTES, total - filled),
      });
      if (next.size !== first.size || next.modifiedMs !== first.modifiedMs) {
        changed = true;
        break;
      }
      chunk = fromBase64(next.bytes);
    }
    if (!changed)
      return { bytes: bytes.subarray(0, filled), size: first.size, modifiedMs: first.modifiedMs };
    if (attempt >= READ_ATTEMPTS) throw new Error("The file kept changing while it was read.");
  }
}

export interface UploadOptions {
  /** A hash: the file must still have it. `null`: it must not exist yet. Left out: overwrite. */
  readonly expectedHash?: FileHash | null;
  /** Bytes sent so far, after each chunk. */
  readonly onProgress?: (sent: number) => void;
  /** Cancels between chunks: nothing is committed, and the server drops the upload. */
  readonly signal?: AbortSignal;
}

/** Writes `bytes` to `path` in chunks, then commits; a commit refused by `expectedHash` throws the `conflict`. */
export async function uploadBytes(
  files: FilesClient,
  folder: FolderPath,
  path: WorkspaceRelativePath,
  bytes: Uint8Array,
  options: UploadOptions = {},
): Promise<FileHash> {
  const { uploadId } = await files.beginWrite({
    folder,
    path,
    ...(options.expectedHash === undefined ? {} : { expectedHash: options.expectedHash }),
  });
  for (let offset = 0; offset < bytes.length; offset += MAX_FILE_CHUNK_BYTES) {
    if (options.signal?.aborted) throw new DOMException("The upload was cancelled.", "AbortError");
    await files.writeChunk({
      uploadId,
      offset,
      bytes: toBase64(bytes.subarray(offset, offset + MAX_FILE_CHUNK_BYTES)),
    });
    options.onProgress?.(Math.min(bytes.length, offset + MAX_FILE_CHUNK_BYTES));
  }
  if (options.signal?.aborted) throw new DOMException("The upload was cancelled.", "AbortError");
  return (await files.commit({ uploadId })).hash;
}

/** Saves bytes as a download in the browser, under `name`. */
export function downloadBytes(bytes: Uint8Array, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The failure's code when it is the app's (`conflict`, `not_found`, …). */
export function failureCode(failure: unknown): string | undefined {
  return (failure as { appError?: { code?: string } } | null)?.appError?.code;
}
