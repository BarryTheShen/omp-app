import type { PortRegistration } from "../../../registry/ports";
import { createAttachmentStoreRegistration } from "./attachment-store";
import { createCheckpointStoreRegistration } from "./checkpoint-store";
import { createConfigStoreRegistration } from "./config-store";
import type { A1PortContext } from "./context";
import { createDraftStoreRegistration } from "./draft-store";
import { createExtensionCatalogRegistration } from "./extension-catalog";
import { createFileSearchRegistration } from "./file-search";
import { createGithubRefsRegistration } from "./github-refs";
import { createHostMetadataRegistration } from "./host-metadata";
import { createMcpCommandsRegistration } from "./mcp-commands";
import { createMemoryStoreRegistration } from "./memory-store";
import { createOmpCommandGatewayRegistration } from "./omp-command-gateway";
import { createPlanDocumentRegistration } from "./plan-documents";
import { createProviderAccountStoreRegistration } from "./provider-accounts";
import { createRuleStoreRegistration } from "./rule-store";
import { createSessionFileStoreRegistration } from "./session-file-store";
import { createSessionImportRegistration } from "./session-import";
import { createSessionPinStoreRegistration } from "./session-pin-store";
import { createUrlCatalogRegistration } from "./url-catalog";
import { createUsageLimitStoreRegistration } from "./usage-limits";
import { createGitStateRegistration, createWorkspaceStateRegistration } from "./workspace-state";

/** All merged A1 registrations. Main composes these into PORT_REGISTRY. */
export function createA1PortRegistrations(context: A1PortContext): readonly PortRegistration[] {
  return [
    createSessionFileStoreRegistration(context),
    createConfigStoreRegistration(context),
    createDraftStoreRegistration(context),
    createCheckpointStoreRegistration(context),
    createWorkspaceStateRegistration(context),
    createGitStateRegistration(context),
    createMcpCommandsRegistration(context),
    createOmpCommandGatewayRegistration(context),
    createSessionPinStoreRegistration(context),
    createAttachmentStoreRegistration(context),
    createSessionImportRegistration(context),
    createProviderAccountStoreRegistration(context),
    createExtensionCatalogRegistration(context),
    createMemoryStoreRegistration(context),
    createFileSearchRegistration(context),
    createHostMetadataRegistration(context),
    createPlanDocumentRegistration(context),
    createRuleStoreRegistration(context),
    createGithubRefsRegistration(context),
    createUrlCatalogRegistration(context),
    createUsageLimitStoreRegistration(context),
  ];
}

export * from "./context";
export * from "./helper";
