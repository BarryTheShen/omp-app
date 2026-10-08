import { z } from "zod";
import { definePort } from "../../core/envelope";
import { ThreadId } from "../../core/ids";
import { Revision } from "./shared";

/**
 * A server name is one word. omp's `/mcp test`, `enable`, `disable` and `remove` read the name as the
 * first whitespace-separated word of their arguments, so a name with a space could be added but never
 * addressed again.
 */
const SERVER_NAME = /^[A-Za-z0-9_.:-]+$/;

export const McpCommandScope = z.enum(["user", "project"]);
export type McpCommandScope = z.infer<typeof McpCommandScope>;

export const McpCommandTransport = z.enum(["stdio", "http", "sse"]);
export type McpCommandTransport = z.infer<typeof McpCommandTransport>;

function isSafeMcpCommandRemoteUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || value.includes("?") || value.includes("#")) return false;
  const authorityStart = value.indexOf("://") + 3;
  const pathStart = value.indexOf("/", authorityStart);
  const authority = value.slice(authorityStart, pathStart < 0 ? value.length : pathStart);
  return authority.length > 0 && !authority.includes("@");
}

export const McpCommandRemoteUrl = z
  .string()
  .min(1)
  .max(2_048)
  .url()
  .refine(
    isSafeMcpCommandRemoteUrl,
    "expected an HTTP(S) server address without credentials, query strings or fragments",
  );
export type McpCommandRemoteUrl = z.infer<typeof McpCommandRemoteUrl>;

export const McpCommandServerName = z
  .string()
  .min(1)
  .max(100)
  .regex(
    SERVER_NAME,
    "Use letters, digits, '.', ':', '-' or '_'; a server name cannot contain spaces.",
  );
export type McpCommandServerName = z.infer<typeof McpCommandServerName>;

export const McpCommandServerStatus = z.enum([
  "configured",
  "connecting",
  "ready",
  "error",
  "disabled",
]);
export type McpCommandServerStatus = z.infer<typeof McpCommandServerStatus>;

export const McpCommandAuthKind = z.enum(["none", "oauth", "api-key", "unknown"]);
export type McpCommandAuthKind = z.infer<typeof McpCommandAuthKind>;

export const McpCommandServerSummary = z.strictObject({
  name: McpCommandServerName,
  scope: McpCommandScope,
  transport: McpCommandTransport,
  enabled: z.boolean(),
  status: McpCommandServerStatus,
  command: z.string().min(1).max(256).optional(),
  /** Server parsers publish only URL origins; credentials, query strings and paths stay private. */
  url: z.string().url().optional(),
  auth: McpCommandAuthKind,
  source: z.strictObject({
    origin: z.string().min(1).max(128),
    path: z.string().min(1).max(4_096).optional(),
    reloadRequired: z.boolean(),
  }),
});
export type McpCommandServerSummary = z.infer<typeof McpCommandServerSummary>;

export const McpCommandServerListArgs = z.strictObject({
  threadId: ThreadId,
  scope: McpCommandScope.optional(),
});
export type McpCommandServerListArgs = z.infer<typeof McpCommandServerListArgs>;

export const McpCommandServerListResult = z.strictObject({
  servers: z.array(McpCommandServerSummary).max(256),
  revision: Revision,
  truncated: z.boolean().default(false),
  skippedCount: z.number().int().nonnegative().default(0),
});
export type McpCommandServerListResult = z.infer<typeof McpCommandServerListResult>;

export const McpCommandPromptSummary = z.strictObject({
  id: z.string().min(1).max(256),
  server: McpCommandServerName,
  name: z.string().min(1).max(256),
  description: z.string().max(2_048).optional(),
});
export type McpCommandPromptSummary = z.infer<typeof McpCommandPromptSummary>;

export const McpCommandPromptListResult = z.strictObject({
  prompts: z.array(McpCommandPromptSummary).max(256),
  revision: Revision,
  truncated: z.boolean().default(false),
  skippedCount: z.number().int().nonnegative().default(0),
});
export type McpCommandPromptListResult = z.infer<typeof McpCommandPromptListResult>;

export const McpCommandResourceSummary = z.strictObject({
  id: z.string().min(1).max(512),
  server: McpCommandServerName,
  uri: z.string().min(1).max(2_048),
  name: z.string().min(1).max(256),
  description: z.string().max(2_048).optional(),
  mimeType: z.string().min(1).max(128).optional(),
});
export type McpCommandResourceSummary = z.infer<typeof McpCommandResourceSummary>;

export const McpCommandResourceListResult = z.strictObject({
  resources: z.array(McpCommandResourceSummary).max(256),
  revision: Revision,
  truncated: z.boolean().default(false),
  skippedCount: z.number().int().nonnegative().default(0),
});
export type McpCommandResourceListResult = z.infer<typeof McpCommandResourceListResult>;

const actionBase = {
  threadId: ThreadId,
  operationId: z.string().min(1).max(128),
};
const namedActionBase = {
  ...actionBase,
  name: McpCommandServerName,
  scope: McpCommandScope,
};

const AddMcpServerArgs = z.strictObject({
  ...actionBase,
  operation: z.literal("add"),
  name: McpCommandServerName,
  scope: McpCommandScope,
  transport: McpCommandTransport.optional(),
  url: McpCommandRemoteUrl.optional(),
  command: z.string().min(1).max(1_024).optional(),
  args: z.array(z.string().max(1_024)).max(128).optional(),
});
const RemoveMcpServerArgs = z.strictObject({
  ...namedActionBase,
  operation: z.literal("remove"),
  confirmed: z.literal(true),
});
const EnableMcpServerArgs = z.strictObject({
  ...namedActionBase,
  operation: z.literal("enable"),
});
const DisableMcpServerArgs = z.strictObject({
  ...namedActionBase,
  operation: z.literal("disable"),
  confirmed: z.literal(true),
});
const TestMcpServerArgs = z.strictObject({
  ...namedActionBase,
  operation: z.literal("test"),
});
const ReloadMcpServersArgs = z.strictObject({
  ...actionBase,
  operation: z.literal("reload"),
});

export const McpCommandActionArgs = z.discriminatedUnion("operation", [
  AddMcpServerArgs,
  RemoveMcpServerArgs,
  EnableMcpServerArgs,
  DisableMcpServerArgs,
  TestMcpServerArgs,
  ReloadMcpServersArgs,
]);
export type McpCommandActionArgs = z.infer<typeof McpCommandActionArgs>;

export const McpCommandActionResult = z.strictObject({
  operationId: z.string().min(1).max(128),
  status: z.enum(["configured", "ready", "disabled"]),
  server: McpCommandServerSummary.nullable(),
  message: z.string().max(2_048).optional(),
});
export type McpCommandActionResult = z.infer<typeof McpCommandActionResult>;

export const McpCommandThreadArgs = z.strictObject({ threadId: ThreadId });
export type McpCommandThreadArgs = z.infer<typeof McpCommandThreadArgs>;

export const McpCommandHelpResult = z.strictObject({
  lines: z.array(z.string().max(2_048)).max(256),
});
export type McpCommandHelpResult = z.infer<typeof McpCommandHelpResult>;

export const McpCommandsPort = definePort({
  name: "A1.mcpCommands",
  methods: {
    servers: {
      args: McpCommandServerListArgs,
      result: McpCommandServerListResult,
      capability: "host.mcp",
    },
    prompts: {
      args: McpCommandThreadArgs,
      result: McpCommandPromptListResult,
      capability: "host.mcp",
    },
    resources: {
      args: McpCommandThreadArgs,
      result: McpCommandResourceListResult,
      capability: "host.mcp",
    },
    action: {
      args: McpCommandActionArgs,
      result: McpCommandActionResult,
      capability: "host.mcp",
    },
    help: {
      args: McpCommandThreadArgs,
      result: McpCommandHelpResult,
      capability: "host.mcp",
    },
  },
  events: {},
});
