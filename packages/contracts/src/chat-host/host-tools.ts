/**
 * Host tools and host URI schemes (SDK plan H5.2e): tools and URL schemes the app gives omp's session, as omp's RPC
 * bridges do (18.12.6 `modes/rpc/host-tools.ts`, `host-uris.ts`). A call, read or write is a request from the host; the
 * server may send a call's progress first (`host_tool_update`), then answers with omp's own result.
 */
import type { AgentToolResult, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import { z } from "zod";

/** A tool the app runs, as omp's `RpcHostToolDefinition`; the host checks names and descriptions as omp does. */
export const HostToolDefinition = z.object({
  name: z.string(),
  label: z.string().optional(),
  description: z.string(),
  /** The tool's parameters as a JSON Schema object. */
  parameters: z.record(z.string(), z.unknown()),
  hidden: z.boolean().optional(),
  loadMode: z.enum(["essential", "discoverable"]).optional() satisfies z.ZodType<
    ToolLoadMode | undefined
  >,
  /** Whether the tool may read `skill://` content. */
  readsSkillUris: z.boolean().optional(),
});
export type HostToolDefinition = z.infer<typeof HostToolDefinition>;

export const SetHostToolsParams = z.object({ tools: z.array(HostToolDefinition) });
export type SetHostToolsParams = z.infer<typeof SetHostToolsParams>;

/** A URL scheme the app answers, as omp's `RpcHostUriSchemeDefinition`; omp's own schemes cannot be taken. */
export const HostUriSchemeDefinition = z.object({
  /** Without `://` (`db`, `notion`). */
  scheme: z.string(),
  description: z.string().optional(),
  /** Whether omp's write tool may write to it. */
  writable: z.boolean().optional(),
  /** Whether what it reads never changes (omp leaves out line anchors). */
  immutable: z.boolean().optional(),
});
export type HostUriSchemeDefinition = z.infer<typeof HostUriSchemeDefinition>;

export const SetHostUriSchemesParams = z.object({ schemes: z.array(HostUriSchemeDefinition) });
export type SetHostUriSchemesParams = z.infer<typeof SetHostUriSchemesParams>;

/** omp's tool result parts: text and images. */
const ToolResultContent = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
  ]),
);

/** A host tool's result, as omp's `AgentToolResult`; `isError` fails the call with the result's text, as in omp. */
export const ToolCallAnswer = z.object({
  content: ToolResultContent,
  details: z.unknown().optional(),
  isError: z.boolean().optional(),
}) satisfies z.ZodType<AgentToolResult<unknown>>;
export type ToolCallAnswer = z.infer<typeof ToolCallAnswer>;

/** A call's progress, sent by the server before it answers the call. */
export const HostToolUpdateParams = z.object({
  /** The id of the host's `tool.call` request. */
  callId: z.string().min(1),
  partialResult: ToolCallAnswer.omit({ isError: true }),
});
export type HostToolUpdateParams = z.infer<typeof HostToolUpdateParams>;

/** A host URI read, as omp's `RpcHostUriResult`; `isError` fails the read with `error`, else `content`. */
export const UriReadAnswer = z.object({
  content: z.string().optional(),
  contentType: z.enum(["text/markdown", "application/json", "text/plain"]).optional(),
  notes: z.array(z.string()).optional(),
  /** This read's own `immutable`, over the scheme's. */
  immutable: z.boolean().optional(),
  isError: z.boolean().optional(),
  error: z.string().optional(),
});
export type UriReadAnswer = z.infer<typeof UriReadAnswer>;

export const UriWriteAnswer = z.object({
  content: z.string().optional(),
  isError: z.boolean().optional(),
  error: z.string().optional(),
});
export type UriWriteAnswer = z.infer<typeof UriWriteAnswer>;

export interface ToolCallRequest {
  /** The model's id for this call. */
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

export interface UriReadRequest {
  readonly url: string;
}

export interface UriWriteRequest {
  readonly url: string;
  readonly content: string;
}

/** omp gave up on a host tool call (its signal aborted): the server stops it. */
export interface ToolCancelEvent {
  readonly type: "tool_cancel";
  readonly requestId: string;
}

/** omp gave up on a host URI read or write. */
export interface UriCancelEvent {
  readonly type: "uri_cancel";
  readonly requestId: string;
}
