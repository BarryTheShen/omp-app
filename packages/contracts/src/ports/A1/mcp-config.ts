import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";
import { McpCommandScope } from "./mcp-commands";

/**
 * How a saved env or header value reaches a page (#16): the page never holds a saved secret, and a value sent back as
 * this keeps the saved one.
 */
export const MCP_SECRET_MASK = "••••••••";

const ValueMap = z.record(z.string().min(1).max(256), z.string().max(8_192));

/**
 * A server's name as omp's config code takes it (`validateServerName`): letters, digits, `_ . : -` and single spaces,
 * as in "MaaS Slack". `/mcp` commands take no spaces (`McpCommandServerName`).
 */
export const McpConfigServerName = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9_.:-]+(?: [A-Za-z0-9_.:-]+)*$/,
    "Use letters, digits, '.', ':', '-', '_' and single spaces.",
  );
export type McpConfigServerName = z.infer<typeof McpConfigServerName>;

/**
 * One MCP server as omp's `mcp.json` keeps it (#16): a local command (`stdio`) with its args, env and folder, or a
 * remote server (`http`, `sse`) with its URL and headers; env and header values masked. Fields omp has that are not here
 * (its sign-in) stay as they are when the server is saved.
 */
export const McpServerConfig = z.strictObject({
  type: z.enum(["stdio", "http", "sse"]),
  command: z.string().min(1).max(1_024).optional(),
  args: z.array(z.string().max(4_096)).max(256).optional(),
  env: ValueMap.optional(),
  cwd: z.string().min(1).max(4_096).optional(),
  url: z.string().min(1).max(4_096).optional(),
  headers: ValueMap.optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().nonnegative().optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** A server in the user's or the folder's `mcp.json`: its name, scope, file, config, and how it signs in. */
export const McpConfigServer = z.strictObject({
  name: McpConfigServerName,
  scope: McpCommandScope,
  path: z.string().min(1).max(4_096),
  config: McpServerConfig,
  auth: z.enum(["none", "oauth", "apikey"]),
});
export type McpConfigServer = z.infer<typeof McpConfigServer>;

export const McpConfigFolderArgs = z.strictObject({ folder: FolderPath });
export type McpConfigFolderArgs = z.infer<typeof McpConfigFolderArgs>;

export const McpConfigListResult = z.strictObject({
  servers: z.array(McpConfigServer).max(256),
});
export type McpConfigListResult = z.infer<typeof McpConfigListResult>;

/** Writes a server, under `name`; with `previousName`, the server of that name is renamed to it. */
export const McpConfigSaveArgs = z.strictObject({
  folder: FolderPath,
  scope: McpCommandScope,
  name: McpConfigServerName,
  previousName: McpConfigServerName.nullable(),
  config: McpServerConfig,
});
export type McpConfigSaveArgs = z.infer<typeof McpConfigSaveArgs>;

export const McpConfigNameArgs = z.strictObject({
  folder: FolderPath,
  scope: McpCommandScope,
  name: McpConfigServerName,
});
export type McpConfigNameArgs = z.infer<typeof McpConfigNameArgs>;

export const McpConfigSetEnabledArgs = z.strictObject({
  folder: FolderPath,
  scope: McpCommandScope,
  name: McpConfigServerName,
  enabled: z.boolean(),
});
export type McpConfigSetEnabledArgs = z.infer<typeof McpConfigSetEnabledArgs>;

/**
 * omp's MCP servers as its config files keep them (#16), the user's (`~/.omp/agent/mcp.json`) and a folder's
 * (`<folder>/.omp/mcp.json`), read and written with omp's own config code; a chat sees a change after `/mcp reload`.
 */
export const McpConfigPort = definePort({
  name: "A1.mcpConfig",
  methods: {
    servers: { args: McpConfigFolderArgs, result: McpConfigListResult, capability: "host.mcp" },
    save: { args: McpConfigSaveArgs, result: z.null(), capability: "host.mcp" },
    remove: { args: McpConfigNameArgs, result: z.null(), capability: "host.mcp" },
    setEnabled: { args: McpConfigSetEnabledArgs, result: z.null(), capability: "host.mcp" },
  },
  events: {},
});
export type McpConfigPort = typeof McpConfigPort;
