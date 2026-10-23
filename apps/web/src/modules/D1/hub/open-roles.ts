import type { AppClient } from "@omp-app/client";
import { AppFailure, type FolderPath } from "@omp-app/contracts";
import type { RoleCycleSettings } from "../model/role-cycle";
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

/**
 * The roles a role cycle steps through, read the way the Model Hub reads them: the roles the dialog lists
 * (`shown`) and the cycle order the saved layer holds. The stores are released before this returns. A read that
 * failed throws omp's words, so a cycle never runs on settings it could not read.
 */
export async function readRoleCycleSettings(
  client: AppClient,
  folder: FolderPath | null,
): Promise<RoleCycleSettings> {
  const roles = await openHubRoles(client, folder);
  try {
    const failed = [roles.saved, roles.shown]
      .map((store) => store.getSnapshot().error)
      .find((error) => error !== null);
    if (failed) throw new AppFailure(failed);
    return {
      modelRoles: roles.shown.getSnapshot().settings.modelRoles,
      cycleOrder: roles.saved.getSnapshot().settings.cycleOrder,
    };
  } finally {
    disposeHubRoles(roles);
  }
}

/** Releases the role stores' subscriptions to omp's config. A layer shown is released once, even when it is the saved one. */
export function disposeHubRoles(roles: HubRoles): void {
  roles.saved.dispose();
  if (roles.shown !== roles.saved) roles.shown.dispose();
}
