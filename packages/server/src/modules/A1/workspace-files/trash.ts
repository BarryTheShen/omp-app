import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FolderPath, type WorkspaceFilesId, WorkspaceRelativePath } from "@omp-app/contracts";
import { z } from "zod";
import {
  assertNotInGit,
  conflictFailure,
  folderRoot,
  notFoundFailure,
  resolveInside,
} from "./paths";
import type { WorkspaceFilesLog } from "./write";

/** Trash older than this is removed by the daily sweep. */
export const TRASH_KEEP_MS = 7 * 24 * 60 * 60_000;

const Manifest = z.strictObject({
  folder: FolderPath,
  path: WorkspaceRelativePath,
  trashedAtMs: z.number().finite(),
});
type Manifest = z.infer<typeof Manifest>;

export interface WorkspaceTrashDeps {
  /** The app's data folder: trash goes to `trash/<id>/`, the item and its manifest. */
  readonly dataDir: string;
  readonly now: () => number;
  readonly log: WorkspaceFilesLog;
}

/** Moves `from` to `to`, copying across file systems (`EXDEV`) when a rename cannot. */
async function moveAcross(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * The Files panel's delete (#2782): nothing is deleted outright. An item moves into the app's trash with a manifest of
 * where it was, comes back with `restore` while its place is free, and is removed for good by a sweep after
 * `TRASH_KEEP_MS`. A symlink is trashed as the link.
 */
export class WorkspaceTrash {
  readonly #deps: WorkspaceTrashDeps;

  constructor(deps: WorkspaceTrashDeps) {
    this.#deps = deps;
  }

  get #dir(): string {
    return join(this.#deps.dataDir, "trash");
  }

  async trash(
    args: { readonly folder: FolderPath; readonly path: WorkspaceRelativePath },
    device: string,
  ): Promise<{ trashId: WorkspaceFilesId }> {
    const root = await folderRoot(args.folder);
    const resolved = await resolveInside(root, args.path);
    assertNotInGit(root, args.path, resolved);
    if (resolved.found === null) throw notFoundFailure(`${args.path} is not there.`);
    const trashId = randomUUID() as WorkspaceFilesId;
    const into = join(this.#dir, trashId);
    await mkdir(into, { recursive: true, mode: 0o700 });
    const manifest: Manifest = {
      folder: args.folder,
      path: args.path,
      trashedAtMs: this.#deps.now(),
    };
    await writeFile(join(into, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    await moveAcross(resolved.target, join(into, "item"));
    this.#deps.log("workspace_files.trash", { path: args.path, device });
    return { trashId };
  }

  async restore(
    args: { readonly trashId: WorkspaceFilesId },
    device: string,
  ): Promise<{ folder: FolderPath; path: WorkspaceRelativePath }> {
    const into = join(this.#dir, args.trashId);
    const manifest = await this.#manifest(into);
    if (manifest === null) throw notFoundFailure("This item is no longer in the trash.");
    const root = await folderRoot(manifest.folder);
    const resolved = await resolveInside(root, manifest.path);
    if (resolved.found !== null)
      throw conflictFailure(`${manifest.path} is taken: something new is there.`);
    await moveAcross(join(into, "item"), resolved.target);
    await rm(into, { recursive: true, force: true });
    this.#deps.log("workspace_files.restore", { path: manifest.path, device });
    return { folder: manifest.folder, path: manifest.path };
  }

  /** Removes trash older than `TRASH_KEEP_MS`, and any trash entry without a readable manifest. */
  async sweep(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return 0;
    }
    const cutoff = this.#deps.now() - TRASH_KEEP_MS;
    let removed = 0;
    for (const name of names) {
      const into = join(this.#dir, name);
      const manifest = await this.#manifest(into);
      if (manifest !== null && manifest.trashedAtMs > cutoff) continue;
      await rm(into, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  async #manifest(into: string): Promise<Manifest | null> {
    try {
      const parsed = Manifest.safeParse(
        JSON.parse(await readFile(join(into, "manifest.json"), "utf8")),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
