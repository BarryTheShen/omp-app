import type { FolderPath, WorkspaceRelativePath } from "@omp-app/contracts";

/** A file opened as a pane of the workspace (#2782 Open as tab): `kind` tells it from a chat's pane. */
export interface FilePaneParams {
  readonly kind: "file";
  readonly folder: FolderPath;
  readonly path: WorkspaceRelativePath;
}

/** The workspace's component name for a file pane. */
export const FILE_PANE_COMPONENT = "file";

/** A file pane's id: one pane per file and folder. */
export const filePaneId = (folder: FolderPath, path: WorkspaceRelativePath) =>
  `file:${folder}:${path}`;

/** Whether a pane's parameters are a file pane's. */
export function isFilePane(params: unknown): params is FilePaneParams {
  return (params as { kind?: unknown } | undefined)?.kind === "file";
}
