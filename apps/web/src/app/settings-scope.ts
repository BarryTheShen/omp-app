import type { ConfigWriteLayer, FolderPath } from "@omp-app/contracts";

/**
 * The folder one settings layer is read and written with. The config store refuses a global write
 * that names a folder and a project write that names none, so "All workspaces" settings are read
 * and saved with no folder and "This workspace" settings with the open one.
 */
export function layerFolder(
  layer: Extract<ConfigWriteLayer, "global" | "project">,
  folder: FolderPath | null,
): FolderPath | null {
  return layer === "project" ? folder : null;
}
