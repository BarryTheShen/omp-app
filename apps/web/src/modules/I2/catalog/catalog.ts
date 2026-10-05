import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type ExtensionCatalogChanged,
  ExtensionCatalog as ExtensionCatalogPort,
  type FolderPath,
  type PortCallOptions,
} from "@omp-app/contracts";
import type { ExtensionCatalog } from "./contract";
import { normalizeCatalog } from "./contract";

function unavailable(error: unknown, action: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure({
    code: "unavailable",
    message: `Extension catalog ${action} is unavailable.`,
    retryable: true,
    capability: "host.extension-catalog",
  });
}

/** Browser adapter over A1.13's typed port through A0.8; it never reads extension files. */
export function createExtensionCatalog(client: AppClient): ExtensionCatalog {
  const port = client.port(ExtensionCatalogPort);
  return Object.freeze({
    async list(folder: FolderPath | null, options?: PortCallOptions) {
      try {
        return normalizeCatalog(await port.list({ folder }, options));
      } catch (error) {
        throw unavailable(error, "list");
      }
    },
    async reload(folder: FolderPath | null, options?: PortCallOptions) {
      try {
        return normalizeCatalog(await port.reload({ folder }, options));
      } catch (error) {
        throw unavailable(error, "reload");
      }
    },
    async subscribe(listener: (change: ExtensionCatalogChanged) => void) {
      try {
        const subscription = await client.subscribe(ExtensionCatalogPort, "changed");
        const removeListener = subscription.onEvent((change) => listener(change));
        return async () => {
          removeListener();
          await subscription.unsubscribe();
        };
      } catch (error) {
        throw unavailable(error, "change events");
      }
    },
  });
}
