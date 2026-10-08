import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, ThreadId } from "@omp-app/contracts";
import type { HostToolPort, HostUriPort } from "../contract";
import { createMcpProtocolCatalogs, type McpProtocolCatalogs } from "./catalog";
import {
  createHostToolPort,
  createHostUriPort,
  type HostRegistrationOptions,
} from "./host-registration";

export interface McpProtocolAdapterOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities?: CapabilityMap;
}

export interface McpProtocolAdapter extends McpProtocolCatalogs {
  readonly hostTools: HostToolPort;
  readonly hostUris: HostUriPort;
}

/** Composes MCP catalogs and AP9 registrations for one open omp thread. */
export function createMcpProtocolAdapter(options: McpProtocolAdapterOptions): McpProtocolAdapter {
  const hostOptions: HostRegistrationOptions = options;
  return {
    ...createMcpProtocolCatalogs(options),
    hostTools: createHostToolPort(hostOptions),
    hostUris: createHostUriPort(hostOptions),
  };
}

export {
  createMcpProtocolCatalogs,
  type McpCatalogController,
  type McpCatalogSnapshot,
  type McpCatalogState,
  type McpNotificationSnapshot,
  type McpPromptCatalogController,
  type McpProtocolCatalogOptions,
  type McpProtocolCatalogs,
  type McpResourceCatalog,
} from "./catalog";
export {
  createHostToolPort,
  createHostUriPort,
  type HostRegistrationOptions,
} from "./host-registration";
