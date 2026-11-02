import { join } from "node:path";
import type { Logger } from "../../../logging";
import type { FileWatchRegistry } from "../fs/file-watch-registry";
import { WorkspaceTrash } from "./trash";
import { WorkspaceWatches } from "./watch";
import { WorkspaceWrites } from "./write";

/** How often idle uploads are dropped, and trash older than a week swept. */
const UPLOAD_SWEEP_MS = 60_000;
const TRASH_SWEEP_MS = 24 * 60 * 60_000;

/** The Files panel's server side (#2782): writes, trash and watches, with their sweeps. */
export interface WorkspaceFilesService {
  readonly writes: WorkspaceWrites;
  readonly trash: WorkspaceTrash;
  readonly watches: WorkspaceWatches;
  /** The device a connection belongs to, for the log; the connection itself when none is known. */
  deviceOf(connectionId: string): string;
  close(): void;
}

export interface WorkspaceFilesOptions {
  /** The app's data folder: uploads and trash live under `workspace-files/` in it. */
  readonly appDataDir: string;
  readonly fileWatch: FileWatchRegistry;
  readonly logger?: Logger;
  readonly deviceOf?: (connectionId: string) => string | null;
  readonly now?: () => number;
}

export function createWorkspaceFiles(options: WorkspaceFilesOptions): WorkspaceFilesService {
  const deps = {
    dataDir: join(options.appDataDir, "workspace-files"),
    now: options.now ?? Date.now,
    log: (event: string, fields: Readonly<Record<string, string>>) =>
      options.logger?.info(event, fields),
  };
  const writes = new WorkspaceWrites(deps);
  const trash = new WorkspaceTrash(deps);
  const watches = new WorkspaceWatches({ registry: options.fileWatch });
  const failed = (event: string) => (error: unknown) =>
    options.logger?.warn(event, { error: error instanceof Error ? error.message : String(error) });
  const uploadSweep = setInterval(
    () => void writes.dropIdle().catch(failed("workspace_files.upload_sweep_failed")),
    UPLOAD_SWEEP_MS,
  );
  const trashSweep = setInterval(
    () => void trash.sweep().catch(failed("workspace_files.trash_sweep_failed")),
    TRASH_SWEEP_MS,
  );
  uploadSweep.unref?.();
  trashSweep.unref?.();
  void trash.sweep().catch(failed("workspace_files.trash_sweep_failed"));
  return {
    writes,
    trash,
    watches,
    deviceOf: (connectionId) => options.deviceOf?.(connectionId) ?? connectionId,
    close() {
      clearInterval(uploadSweep);
      clearInterval(trashSweep);
      watches.close();
    },
  };
}
