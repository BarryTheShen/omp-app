import type { AppClient } from "@omp-app/client";
import type { FolderPath } from "@omp-app/contracts";
import { createConfigModelSettingsPort, ModelRoleStore } from "../model/roles";
import type { HubRoles } from "./model-hub-controller";

/**
 * Reads the saved roles (the global layer, which also holds the presets and the cycle order) and the
 * storage choice. When the choice is per project and a folder is open, the roles the dialog lists are the
 * project's, read over the saved ones (ConfigStore merges the layers).
 */
export async function openHubRoles(
  client: AppClient,
  folder: FolderPath | null,
): Promise<HubRoles> {
  const saved = new ModelRoleStore(
    createConfigModelSettingsPort(client, { folder: null, layer: "global" }),
  );
  const snapshot = await saved.read();
  if (snapshot.status === "error" || folder === null) return { saved, shown: saved };
  if (snapshot.settings.modelRoleStorage !== "project") return { saved, shown: saved };
  const shown = new ModelRoleStore(
    createConfigModelSettingsPort(client, { folder, layer: "project" }),
  );
  await shown.read();
  return { saved, shown };
}
