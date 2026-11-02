import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FileHash,
  FolderPath,
  WorkspaceBeginWriteArgs,
  WorkspaceFilesId,
  WorkspaceMoveArgs,
  WorkspaceRelativePath,
  WorkspaceWriteChunkArgs,
} from "@omp-app/contracts";
import { compareAndSwapFile, writeFileAtomic } from "../fs/atomic-file";
import {
  assertNotInGit,
  conflictFailure,
  folderRoot,
  invalidFailure,
  notFoundFailure,
  resolveInside,
} from "./paths";

/** An upload larger than this is refused: the largest file a viewer opens. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** An upload that gets no chunk for this long is dropped with its bytes. */
export const UPLOAD_IDLE_MS = 10 * 60_000;

/** Who changed what, for the server log; a file's contents are never logged. */
export type WorkspaceFilesLog = (event: string, fields: Readonly<Record<string, string>>) => void;

export interface WorkspaceWritesDeps {
  /** The app's data folder: uploads wait in `uploads/` until they commit. */
  readonly dataDir: string;
  readonly now: () => number;
  readonly log: WorkspaceFilesLog;
}

interface Upload {
  readonly folder: FolderPath;
  readonly path: WorkspaceRelativePath;
  readonly expectedHash: FileHash | null | undefined;
  readonly file: string;
  readonly device: string;
  received: number;
  touchedMs: number;
}

/**
 * Writes into a chat's folder (#2782). An upload's bytes go to a temp file under the app's data folder, in order; its
 * commit replaces the file through `compareAndSwapFile`, so a file that changed since it was opened (its hash no longer
 * the expected one) is left as it was and the commit fails with `conflict`. Moves never overwrite; nothing is written
 * under `.git`.
 */
export class WorkspaceWrites {
  readonly #deps: WorkspaceWritesDeps;
  readonly #uploads = new Map<WorkspaceFilesId, Upload>();

  constructor(deps: WorkspaceWritesDeps) {
    this.#deps = deps;
  }

  get #uploadDir(): string {
    return join(this.#deps.dataDir, "uploads");
  }

  async beginWrite(
    args: WorkspaceBeginWriteArgs,
    device: string,
  ): Promise<{ uploadId: WorkspaceFilesId }> {
    await this.dropIdle();
    const root = await folderRoot(args.folder);
    const resolved = await resolveInside(root, args.path);
    assertNotInGit(root, args.path, resolved);
    if (resolved.found?.isDirectory()) throw invalidFailure(`${args.path} is a directory.`);
    const uploadId = randomUUID() as WorkspaceFilesId;
    await mkdir(this.#uploadDir, { recursive: true, mode: 0o700 });
    const file = join(this.#uploadDir, uploadId);
    await writeFile(file, new Uint8Array(), { mode: 0o600 });
    this.#uploads.set(uploadId, {
      folder: args.folder,
      path: args.path,
      expectedHash: args.expectedHash,
      file,
      device,
      received: 0,
      touchedMs: this.#deps.now(),
    });
    return { uploadId };
  }

  async writeChunk(args: WorkspaceWriteChunkArgs): Promise<{ received: number }> {
    const upload = this.#upload(args.uploadId);
    if (args.offset !== upload.received) {
      throw invalidFailure(
        `The chunk starts at ${args.offset}; the upload has ${upload.received} bytes.`,
      );
    }
    const bytes = Buffer.from(args.bytes, "base64");
    if (upload.received + bytes.length > MAX_UPLOAD_BYTES) {
      await this.#drop(args.uploadId);
      throw invalidFailure("The file is larger than an upload takes (100 MiB).");
    }
    await appendFile(upload.file, bytes);
    upload.received += bytes.length;
    upload.touchedMs = this.#deps.now();
    return { received: upload.received };
  }

  async commit(args: { readonly uploadId: WorkspaceFilesId }): Promise<{ hash: FileHash }> {
    const upload = this.#upload(args.uploadId);
    try {
      // The path is taken again: its directory may have moved since the upload began.
      const root = await folderRoot(upload.folder);
      const resolved = await resolveInside(root, upload.path);
      assertNotInGit(root, upload.path, resolved);
      if (resolved.found?.isDirectory()) throw invalidFailure(`${upload.path} is a directory.`);
      const content = await readFile(upload.file);
      const { hash } =
        upload.expectedHash === undefined
          ? await writeFileAtomic(resolved.target, content)
          : await compareAndSwapFile(resolved.target, content, upload.expectedHash);
      this.#deps.log("workspace_files.write", {
        path: upload.path,
        bytes: String(content.length),
        device: upload.device,
        ...(upload.expectedHash === undefined ? { overwrite: "true" } : {}),
      });
      return { hash: hash as FileHash };
    } finally {
      await this.#drop(args.uploadId);
    }
  }

  async createDirectory(
    args: { readonly folder: FolderPath; readonly path: WorkspaceRelativePath },
    device: string,
  ): Promise<Record<string, never>> {
    const root = await folderRoot(args.folder);
    const resolved = await resolveInside(root, args.path);
    assertNotInGit(root, args.path, resolved);
    if (resolved.found !== null) throw conflictFailure(`${args.path} is already there.`);
    await mkdir(resolved.target);
    this.#deps.log("workspace_files.create_directory", { path: args.path, device });
    return {};
  }

  /** A rename or a move; the place it goes to must be free. A symlink moves as the link. */
  async move(args: WorkspaceMoveArgs, device: string): Promise<Record<string, never>> {
    const root = await folderRoot(args.folder);
    const from = await resolveInside(root, args.from);
    const to = await resolveInside(root, args.to);
    assertNotInGit(root, args.from, from);
    assertNotInGit(root, args.to, to);
    if (from.found === null) throw notFoundFailure(`${args.from} is not there.`);
    if (to.found !== null) throw conflictFailure(`${args.to} is already there.`);
    if (from.found.isDirectory() && `${to.target}/`.startsWith(`${from.target}/`)) {
      throw invalidFailure("A folder cannot move into itself.");
    }
    await rename(from.target, to.target);
    this.#deps.log("workspace_files.move", { from: args.from, to: args.to, device });
    return {};
  }

  /** Drops the uploads that got no chunk for `UPLOAD_IDLE_MS`, with their bytes. */
  async dropIdle(): Promise<void> {
    const now = this.#deps.now();
    for (const [uploadId, upload] of [...this.#uploads]) {
      if (now - upload.touchedMs >= UPLOAD_IDLE_MS) await this.#drop(uploadId);
    }
  }

  /** Uploads not yet committed or dropped. */
  get pending(): number {
    return this.#uploads.size;
  }

  #upload(uploadId: WorkspaceFilesId): Upload {
    const upload = this.#uploads.get(uploadId);
    if (upload === undefined)
      throw notFoundFailure("This upload is gone: it was committed, cancelled or left idle.");
    return upload;
  }

  async #drop(uploadId: WorkspaceFilesId): Promise<void> {
    const upload = this.#uploads.get(uploadId);
    if (upload === undefined) return;
    this.#uploads.delete(uploadId);
    await rm(upload.file, { force: true });
  }
}
