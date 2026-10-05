import type { CapabilityKey } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

export const I1_CAPABILITIES = {
  mcp: "host.mcp",
  mcpSettings: "client.mcp-settings",
  hostTools: "omp.host-tools",
  hostUris: "omp.host-uris",
} as const satisfies Record<string, CapabilityKey>;

export const McpScope = z.enum(["user", "project", "foreign"]);
export type McpScope = z.infer<typeof McpScope>;

export const McpTransport = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof McpTransport>;

export const McpServerStatus = z.enum(["configured", "connecting", "ready", "error", "disabled"]);
export type McpServerStatus = z.infer<typeof McpServerStatus>;

export const McpAuthKind = z.enum(["none", "oauth", "api-key", "unknown"]);
export type McpAuthKind = z.infer<typeof McpAuthKind>;

export const McpAuthStatus = z.enum([
  "none",
  "configured",
  "required",
  "authenticated",
  "expired",
  "error",
]);
export type McpAuthStatus = z.infer<typeof McpAuthStatus>;

export const McpServerName = z
  .string()
  .min(1)
  .max(128)
  .regex(NAME_PATTERN, "invalid MCP server name");
export type McpServerName = z.infer<typeof McpServerName>;

export const McpSource = z.strictObject({
  origin: z.string().min(1).max(128),
  path: z.string().min(1).max(4_096).optional(),
  reloadRequired: z.boolean(),
});
export type McpSource = z.infer<typeof McpSource>;

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** A URL origin only; paths, query tokens, credentials and fragments are not browser DTO data. */
export const McpUrlOrigin = z
  .string()
  .url()
  .refine(isOrigin, "expected a URL origin without credentials or query data");
export type McpUrlOrigin = z.infer<typeof McpUrlOrigin>;

export const McpServerSummary = z.strictObject({
  name: McpServerName,
  scope: McpScope,
  transport: McpTransport,
  enabled: z.boolean(),
  status: McpServerStatus,
  command: z.string().min(1).max(256).optional(),
  url: McpUrlOrigin.optional(),
  auth: McpAuthKind,
  source: McpSource,
});
export type McpServerSummary = z.infer<typeof McpServerSummary>;

/** Redacted server config: args are safe display args only; env/header values can never appear. */
export const McpServerConfig = McpServerSummary.extend({
  args: z.array(z.string().max(1_024)).max(128).optional(),
  envKeys: z.array(z.string().min(1).max(256)).max(256).optional(),
  headers: z.array(z.string().min(1).max(256)).max(256).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const McpAuthSummary = z.strictObject({
  kind: McpAuthKind,
  status: McpAuthStatus,
  accountLabel: z.string().min(1).max(256).optional(),
  expiresAt: z.string().datetime().optional(),
});
export type McpAuthSummary = z.infer<typeof McpAuthSummary>;

export const McpServerListArgs = z.strictObject({ scope: McpScope.optional() });
export type McpServerListArgs = z.infer<typeof McpServerListArgs>;

export const McpServerListResult = z.strictObject({
  servers: z.array(McpServerSummary).max(256),
  revision: z.string().min(1),
});
export type McpServerListResult = z.infer<typeof McpServerListResult>;

export const McpServerActionArgs = z.strictObject({
  name: McpServerName,
  scope: McpScope,
  operationId: z.string().min(1).max(128),
  confirmed: z.boolean().optional(),
});
export type McpServerActionArgs = z.infer<typeof McpServerActionArgs>;

export const McpServerActionResult = z.strictObject({
  operationId: z.string().min(1).max(128),
  status: McpServerStatus,
  server: McpServerSummary.nullable(),
  message: z.string().max(2_048).optional(),
});
export type McpServerActionResult = z.infer<typeof McpServerActionResult>;

export type McpPortCallOptions = { readonly signal?: AbortSignal };

export interface McpServerPort {
  list(args?: McpServerListArgs, options?: McpPortCallOptions): Promise<McpServerListResult>;
  add(args: McpServerActionArgs, options?: McpPortCallOptions): Promise<McpServerActionResult>;
  remove(args: McpServerActionArgs, options?: McpPortCallOptions): Promise<McpServerActionResult>;
  enable(args: McpServerActionArgs, options?: McpPortCallOptions): Promise<McpServerActionResult>;
  disable(args: McpServerActionArgs, options?: McpPortCallOptions): Promise<McpServerActionResult>;
  test(args: McpServerActionArgs, options?: McpPortCallOptions): Promise<McpServerActionResult>;
  reconnect(
    args: McpServerActionArgs,
    options?: McpPortCallOptions,
  ): Promise<McpServerActionResult>;
  reload(args: McpServerActionArgs, options?: McpPortCallOptions): Promise<McpServerActionResult>;
}

export const McpPromptSummary = z.strictObject({
  id: z.string().min(1).max(256),
  server: McpServerName,
  name: z.string().min(1).max(256),
  description: z.string().max(2_048).optional(),
});
export type McpPromptSummary = z.infer<typeof McpPromptSummary>;

export const McpResourceSummary = z.strictObject({
  id: z.string().min(1).max(512),
  server: McpServerName,
  uri: z.string().min(1).max(2_048),
  name: z.string().min(1).max(256),
  description: z.string().max(2_048).optional(),
  mimeType: z.string().min(1).max(128).optional(),
});
export type McpResourceSummary = z.infer<typeof McpResourceSummary>;

export const McpPromptInvokeArgs = z.strictObject({
  id: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.string()).default({}),
});
export type McpPromptInvokeArgs = z.infer<typeof McpPromptInvokeArgs>;

export const PromptExpansionResult = z.strictObject({
  promptId: z.string().min(1).max(256),
  server: McpServerName,
  messages: z.array(
    z.strictObject({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    }),
  ),
  source: z.literal("mcp_prompt"),
});
export type PromptExpansionResult = z.infer<typeof PromptExpansionResult>;

export interface McpPromptCatalog {
  list(options?: McpPortCallOptions): Promise<readonly McpPromptSummary[]>;
  invoke(args: McpPromptInvokeArgs, options?: McpPortCallOptions): Promise<PromptExpansionResult>;
}

export const HostToolName = z
  .string()
  .min(1)
  .max(128)
  .regex(NAME_PATTERN, "invalid host tool name");
export type HostToolName = z.infer<typeof HostToolName>;

export const HostToolDefinition = z.strictObject({
  name: HostToolName,
  description: z.string().max(2_048).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type HostToolDefinition = z.infer<typeof HostToolDefinition>;

export const HostToolRegistrationResult = z.strictObject({
  names: z.array(HostToolName).max(256),
});
export type HostToolRegistrationResult = z.infer<typeof HostToolRegistrationResult>;

export interface HostToolPort {
  setTools(
    tools: readonly HostToolDefinition[],
    options?: McpPortCallOptions,
  ): Promise<HostToolRegistrationResult>;
  unregister(name: HostToolName, options?: McpPortCallOptions): Promise<void>;
}

export const HostUriScheme = z
  .string()
  .min(1)
  .max(64)
  .regex(URI_SCHEME_PATTERN, "invalid URI scheme");
export type HostUriScheme = z.infer<typeof HostUriScheme>;

export const HostUriDefinition = z.strictObject({
  scheme: HostUriScheme,
  operations: z
    .array(z.enum(["read", "write"]))
    .min(1)
    .max(2),
  description: z.string().max(2_048).optional(),
});
export type HostUriDefinition = z.infer<typeof HostUriDefinition>;

export const HostUriRegistrationResult = z.strictObject({
  schemes: z.array(HostUriScheme).max(256),
});
export type HostUriRegistrationResult = z.infer<typeof HostUriRegistrationResult>;

export interface HostUriPort {
  setSchemes(
    schemes: readonly HostUriDefinition[],
    options?: McpPortCallOptions,
  ): Promise<HostUriRegistrationResult>;
  unregister(scheme: HostUriScheme, options?: McpPortCallOptions): Promise<void>;
}

export const McpSettingsSection = z.strictObject({
  section: z.literal("tools/Discovery & MCP"),
  keys: z.array(z.string().min(1)).max(32),
});
export type McpSettingsSection = z.infer<typeof McpSettingsSection>;

/** Converts an untrusted server/config snapshot to the browser-safe DTO; secret values are dropped. */
export function redactMcpServerConfig(value: unknown): McpServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.name !== "string" ||
    typeof raw.scope !== "string" ||
    typeof raw.transport !== "string" ||
    typeof raw.enabled !== "boolean" ||
    typeof raw.status !== "string"
  ) {
    return null;
  }
  const source =
    typeof raw.source === "object" && raw.source !== null
      ? (raw.source as Record<string, unknown>)
      : {};
  const rawUrl = typeof raw.url === "string" ? raw.url : undefined;
  let url: string | undefined;
  if (rawUrl !== undefined) {
    try {
      url = new URL(rawUrl).origin;
    } catch {
      url = undefined;
    }
  }
  const safePath =
    source.safePath === true && typeof source.path === "string" ? source.path : undefined;
  const summary = {
    name: raw.name,
    scope: raw.scope,
    transport: raw.transport,
    enabled: raw.enabled,
    status: raw.status,
    ...(typeof raw.command === "string" ? { command: raw.command.split(/\s+/, 1)[0] } : {}),
    ...(url === undefined ? {} : { url }),
    auth: typeof raw.auth === "string" ? raw.auth : "unknown",
    source: {
      origin: typeof source.origin === "string" ? source.origin : "unknown",
      ...(safePath === undefined ? {} : { path: safePath }),
      reloadRequired: source.reloadRequired === true,
    },
    ...(typeof raw.env === "object" && raw.env !== null
      ? { envKeys: Object.keys(raw.env as Record<string, unknown>) }
      : {}),
    ...(typeof raw.headers === "object" && raw.headers !== null
      ? { headers: Object.keys(raw.headers as Record<string, unknown>) }
      : {}),
  };
  const parsed = McpServerConfig.safeParse(summary);
  return parsed.success ? parsed.data : null;
}

/** Converts unknown command/transport failures without echoing untrusted MCP payloads. */
export function toI1Failure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    { code: "internal", message: fallback, retryable: false },
    { cause: error },
  );
}
