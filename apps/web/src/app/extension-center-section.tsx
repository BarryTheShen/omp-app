import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, FolderPath, ThreadId } from "@omp-app/contracts";
import { useMemo } from "react";
import {
  createExtensionCatalog,
  createMarketplacePort,
  I2CapabilityKeys,
} from "@/modules/I2/catalog";
import { ExtensionControlCenter } from "@/modules/I2/extensions";

/**
 * Whether the Tools tab shows the extension control center: the host must serve the extension catalog.
 * Without it the section is not shown.
 */
export function extensionCenterAvailable(capabilities: CapabilityMap): boolean {
  return capabilities[I2CapabilityKeys.extensionCatalog]?.state === "available";
}

/** The extension control center (I2) on the settings Tools tab. */
export function ExtensionCenterSection({
  client,
  folder,
  capabilities,
  threadId,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath | null;
  readonly capabilities: CapabilityMap;
  readonly threadId: ThreadId | null;
}) {
  const catalog = useMemo(() => createExtensionCatalog(client), [client]);
  const marketplace = useMemo(() => createMarketplacePort(client), [client]);
  return (
    <div className="min-w-0">
      <ExtensionControlCenter
        capabilities={capabilities}
        catalog={catalog}
        folder={folder}
        marketplace={marketplace}
        threadId={threadId}
      />
    </div>
  );
}
