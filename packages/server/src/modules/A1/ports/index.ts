import type { PortRegistration } from "../../../registry/ports";
import { createCheckpointStoreRegistration } from "./checkpoint-store";
import { createConfigStoreRegistration } from "./config-store";
import type { A1PortContext } from "./context";
import { createDraftStoreRegistration } from "./draft-store";
import { createExtensionCatalogRegistration } from "./extension-catalog";
import { createFileSearchRegistration } from "./file-search";
import { createHostMetadataRegistration } from "./host-metadata";
import { createOmpCommandGatewayRegistration } from "./omp-command-gateway";
import { createPlanDocumentRegistration } from "./plan-documents";
import { createProviderAccountStoreRegistration } from "./provider-accounts";
import { createSessionFileStoreRegistration } from "./session-file-store";
import { createSessionPinStoreRegistration } from "./session-pin-store";
import { createGitStateRegistration, createWorkspaceStateRegistration } from "./workspace-state";

/** All A1 registrations currently backed by merged stores. Main composes this into PORT_REGISTRY. */
export function createA1PortRegistrations(context: A1PortContext): readonly PortRegistration[] {
  return [
    createSessionFileStoreRegistration(context),
    createConfigStoreRegistration(context),
    createDraftStoreRegistration(context),
    createCheckpointStoreRegistration(context),
    createWorkspaceStateRegistration(context),
    createGitStateRegistration(context),
    createOmpCommandGatewayRegistration(context),
    createSessionPinStoreRegistration(context),
    createProviderAccountStoreRegistration(context),
    createExtensionCatalogRegistration(context),
    createFileSearchRegistration(context),
    createHostMetadataRegistration(context),
    createPlanDocumentRegistration(context),
  ];
}

export * from "./context";
export * from "./helper";
export { createRuleStoreRegistration } from "./rule-store";
