import type { CapabilityKey, CapabilityMap } from "@omp-app/contracts";
import type { McpAuthKind, McpServerStatus, McpServerSummary } from "../contract";

/** AP6: MCP auth has no RPC UI handler (docs_rpc.md:1034-1035; helpers/mcp.ts:486-505). */
export const MCP_AUTH_CAPABILITY = "upstream.mcp-auth" as const satisfies CapabilityKey;
export const MCP_AUTH_UNAVAILABLE_REASON =
  "Signing in to an MCP server only works in the omp terminal for now.";

export const MCP_AUTH_ACTIONS = ["reauth", "unauth", "smithery-login", "smithery-logout"] as const;
export type McpAuthAction = (typeof MCP_AUTH_ACTIONS)[number];

export const MCP_AUTH_ACTION_CAPABILITIES = {
  reauth: MCP_AUTH_CAPABILITY,
  unauth: MCP_AUTH_CAPABILITY,
  "smithery-login": MCP_AUTH_CAPABILITY,
  "smithery-logout": MCP_AUTH_CAPABILITY,
} as const satisfies Readonly<Record<McpAuthAction, CapabilityKey>>;

export type McpAuthAvailability =
  | { readonly state: "available"; readonly capability: CapabilityKey }
  | {
      readonly state: "unavailable";
      readonly capability: CapabilityKey;
      readonly reason: string;
    };

export function getMcpAuthAvailability(
  action: McpAuthAction,
  capabilities: CapabilityMap,
): McpAuthAvailability {
  const capability = MCP_AUTH_ACTION_CAPABILITIES[action];
  if (capabilities[capability]?.state === "available") {
    return { state: "available", capability };
  }
  return { state: "unavailable", capability, reason: MCP_AUTH_UNAVAILABLE_REASON };
}
const AUTH_KIND_LABELS = {
  none: "No authentication",
  oauth: "OAuth",
  "api-key": "API key",
  unknown: "Not reported",
} as const satisfies Readonly<Record<McpAuthKind, string>>;

const SERVER_STATUS_LABELS = {
  configured: "Configured",
  connecting: "Connecting",
  ready: "Connected",
  error: "Connection error",
  disabled: "Disabled",
} as const satisfies Readonly<Record<McpServerStatus, string>>;

export type McpServerAuthViewModel = {
  readonly authenticationType: string;
  readonly connectionStatus: string;
  readonly authActionsAvailable: boolean;
  readonly unavailableReason?: string;
};

export function getMcpServerAuthViewModel(
  server: McpServerSummary,
  capabilities: CapabilityMap,
): McpServerAuthViewModel {
  const unavailable = MCP_AUTH_ACTIONS.map((action) =>
    getMcpAuthAvailability(action, capabilities),
  ).find((availability) => availability.state === "unavailable");
  return {
    authenticationType: AUTH_KIND_LABELS[server.auth],
    connectionStatus: SERVER_STATUS_LABELS[server.status],
    authActionsAvailable: unavailable === undefined,
    ...(unavailable ? { unavailableReason: unavailable.reason } : {}),
  };
}
