import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CommandRunResult,
  OmpCommandGateway,
  type PortCallOptions,
  type PortClient,
  type SlashCommand,
  type ThreadId,
} from "@omp-app/contracts";
import {
  I1_CAPABILITIES,
  type McpPortCallOptions,
  McpScope,
  McpServerActionArgs,
  type McpServerActionArgs as McpServerActionArgsValue,
  McpServerActionResult,
  type McpServerActionResult as McpServerActionResultValue,
  type McpServerListArgs,
  McpServerListResult,
  type McpServerListResult as McpServerListResultValue,
  McpServerName,
  type McpServerPort,
  type McpServerSummary,
  McpTransport,
} from "../contract";

type OmpGatewayPort = PortClient<typeof OmpCommandGateway>;

const MAX_OUTPUTS = 256;
const MAX_OUTPUT_CHARS = 4_000;
const MAX_RAW_FAILURE_CHARS = 8_000;
const MAX_ACTION_MESSAGE_CHARS = 2_048;
// biome-ignore lint/complexity/useRegexLiterals: ANSI escape matching needs a string escape to avoid a source control character.
const ANSI_ESCAPE = new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "g");
const URL_CREDENTIALS = /([a-z][a-z\d+.-]*:\/\/)[^/\s@]+@/gi;
const QUERY_CREDENTIALS = /([?&](?:token|secret|password|authorization|api[_-]?key)=)[^&#\s]+/gi;
const BEARER_CREDENTIALS = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const BASIC_CREDENTIALS = /\bBasic\s+[A-Za-z0-9+/=]{12,}/gi;
const PRIVATE_PATH = /(?:\/home\/[^\s"']+|\/Users\/[^\s"']+|\/root\/[^\s"']+|\/tmp\/[^\s"']+)/g;

/**
 * The command grammar and output strings are copied from omp v18.6.1, not
 * inferred from the TUI. The command catalog is in
 * `packages/coding-agent/src/slash-commands/builtin-session.ts:695-733`;
 * RPC/text output is in `packages/coding-agent/src/slash-commands/helpers/mcp.ts`:
 * list rows `388-412`, test/add/remove/toggle output `282-325`, `424-466`,
 * and reload output `519-521`. TUI-only reconnect output is in
 * `packages/coding-agent/src/modes/controllers/mcp-command-controller.ts:2169-2202`.
 */

export type McpAddServerArgs = McpServerActionArgsValue & {
  /** Transport is optional only for compatibility with McpServerActionArgs; add validates it. */
  readonly transport?: McpTransport;
  /** HTTP/SSE URLs are origin-only in the browser contract; credentials and query strings are refused. */
  readonly url?: string;
  /** Stdio executable, without environment or credential expansion. */
  readonly command?: string;
  /** Safe stdio arguments; credential-bearing flags are refused. */
  readonly args?: readonly string[];
};

export type McpServerLifecycleOperation =
  | "list"
  | "add"
  | "remove"
  | "enable"
  | "disable"
  | "test"
  | "reconnect"
  | "reload"
  | "help";

export type McpServerActionRequest = McpServerActionArgsValue;

export interface McpServerLifecyclePort extends Omit<McpServerPort, "add"> {
  readonly capability: typeof I1_CAPABILITIES.mcp;
  add(args: McpAddServerArgs, options?: McpPortCallOptions): Promise<McpServerActionResultValue>;
  toggle(
    args: McpServerActionArgsValue & { readonly enabled: boolean },
    options?: McpPortCallOptions,
  ): Promise<McpServerActionResultValue>;
  help(options?: McpPortCallOptions): Promise<readonly string[]>;
}

function invalid(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function failure(
  code: "unavailable" | "invalid_args" | "omp_error" | "cancelled" | "not_found" | "internal",
  message: string,
  retryable: boolean,
): AppFailure {
  return new AppFailure({ code, message, retryable, capability: I1_CAPABILITIES.mcp });
}

function shellWord(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalid(`${label} must not be empty.`);
  if (trimmed.length > 1_024 || trimmed.includes("\u0000")) {
    throw invalid(`${label} is too long or contains an invalid character.`);
  }
  if (/\s/.test(trimmed) || /['"\\$`]/.test(trimmed)) {
    return `'${trimmed.replaceAll("'", `'"'"'`)}'`;
  }
  return trimmed;
}

function actionArgs(value: McpServerActionArgsValue): McpServerActionArgsValue {
  const parsed = McpServerActionArgs.safeParse(value);
  if (!parsed.success) throw invalid("Invalid MCP server action arguments.");
  if (parsed.data.scope === "foreign") {
    throw invalid("MCP lifecycle commands support only user and project scopes.");
  }
  return parsed.data;
}

function addArgs(value: McpAddServerArgs): McpAddServerArgs {
  const { transport, url, command, args, ...base } = value;
  const parsed = actionArgs(base);
  if (transport !== undefined && !McpTransport.safeParse(transport).success) {
    throw invalid("MCP add transport must be stdio, http or sse.");
  }
  const hasUrl = url !== undefined;
  const hasCommand = command !== undefined;
  if (hasUrl === hasCommand) {
    throw invalid("MCP add requires exactly one of url or command.");
  }
  if (hasUrl && transport !== "http" && transport !== "sse") {
    throw invalid("HTTP/SSE MCP add requires transport http or sse.");
  }
  if (hasCommand && transport !== undefined && transport !== "stdio") {
    throw invalid("Stdio MCP add requires transport stdio.");
  }
  if (args !== undefined && !hasCommand) {
    throw invalid("MCP add arguments require a stdio command.");
  }
  if (args !== undefined) {
    if (args.length > 128) throw invalid("MCP add has too many command arguments.");
    for (const arg of args) {
      if (/(?:^|[-_])(token|secret|password|api[-_]?key|authorization)(?:$|[-_=])/i.test(arg)) {
        throw invalid("MCP add command arguments must not contain credential flags.");
      }
    }
  }
  if (hasUrl) {
    const trimmedUrl = url.trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      throw invalid("MCP add URL must be a valid URL origin.");
    }
    if (
      (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
      parsedUrl.username !== "" ||
      parsedUrl.password !== "" ||
      parsedUrl.pathname !== "/" ||
      parsedUrl.search !== "" ||
      parsedUrl.hash !== ""
    ) {
      throw invalid(
        "MCP add URL must be an HTTP(S) origin without credentials, path or query data.",
      );
    }
  }
  return { ...value, ...parsed };
}

function commandForAdd(value: McpAddServerArgs): SlashCommand {
  const parsed = addArgs(value);
  const words = ["/mcp", "add", shellWord(parsed.name, "MCP server name"), "--scope", parsed.scope];
  if (parsed.url !== undefined) {
    if (parsed.transport !== "http" && parsed.transport !== "sse") {
      throw invalid("HTTP/SSE MCP add requires transport http or sse.");
    }
    words.push("--url", shellWord(parsed.url, "MCP URL"), "--transport", parsed.transport);
  } else {
    if (parsed.command === undefined) throw invalid("MCP add requires a stdio command.");
    words.push("--", shellWord(parsed.command, "MCP command"));
    for (const arg of parsed.args ?? []) words.push(shellWord(arg, "MCP command argument"));
  }
  return words.join(" ") as SlashCommand;
}

function commandForAction(
  operation: Exclude<McpServerLifecycleOperation, "list" | "add" | "help">,
  value: McpServerActionArgsValue,
): SlashCommand {
  const parsed = actionArgs(value);
  const name = shellWord(parsed.name, "MCP server name");
  switch (operation) {
    case "remove":
      if (parsed.confirmed !== true) throw invalid("Removing an MCP server requires confirmation.");
      return `/mcp remove ${name} --scope ${parsed.scope}` as SlashCommand;
    case "enable":
      return `/mcp enable ${name}` as SlashCommand;
    case "disable":
      if (parsed.confirmed !== true)
        throw invalid("Disabling an MCP server requires confirmation.");
      return `/mcp disable ${name}` as SlashCommand;
    case "test":
      return `/mcp test ${name}` as SlashCommand;
    case "reconnect":
      return `/mcp reconnect ${name}` as SlashCommand;
    case "reload":
      return "/mcp reload" as SlashCommand;
  }
}

function commandForList(args: McpServerListArgs | undefined): SlashCommand {
  if (args?.scope !== undefined) {
    if (!McpScope.safeParse(args.scope).success) throw invalid("Invalid MCP list scope.");
    if (args.scope === "foreign") {
      throw invalid("The omp /mcp list command exposes only user and project servers.");
    }
  }
  return "/mcp list" as SlashCommand;
}

function outputText(result: CommandRunResult): string {
  return result.outputs
    .slice(0, MAX_OUTPUTS)
    .map((output) => sanitizeOutput(output.text).slice(0, MAX_OUTPUT_CHARS))
    .join("\n")
    .trim();
}

function sanitizeOutput(value: string): string {
  return value
    .replace(ANSI_ESCAPE, "")
    .replace(URL_CREDENTIALS, "$1<redacted>@")
    .replace(QUERY_CREDENTIALS, "$1<redacted>")
    .replace(BEARER_CREDENTIALS, "Bearer <redacted>")
    .replace(BASIC_CREDENTIALS, "Basic <redacted>")
    .replace(PRIVATE_PATH, "<private-path>");
}

function safeFailureText(value: string): string {
  const text = sanitizeOutput(value).trim();
  if (text.length === 0) return "(empty output)";
  return text.length > MAX_RAW_FAILURE_CHARS ? `${text.slice(0, MAX_RAW_FAILURE_CHARS)}…` : text;
}

function outputFailure(
  operation: string,
  output: string,
  detail = "The output shape is not recognized.",
): AppFailure {
  return failure(
    "internal",
    `MCP ${operation} couldn't read this output safely: ${detail}\nRaw output:\n${safeFailureText(output)}`,
    false,
  );
}

function knownFailure(
  operation: McpServerLifecycleOperation,
  output: string,
): AppFailure | undefined {
  const text = output.trim();
  if (text.length === 0) return undefined;
  if (/cancel(?:led|lation)|aborted/i.test(text)) {
    return failure("cancelled", safeFailureText(text), false);
  }
  if (
    /requires OAuth or browser flows|requires the TUI client|manager not available|No MCP manager available/i.test(
      text,
    )
  ) {
    return failure("unavailable", safeFailureText(text), false);
  }
  if (/not found/i.test(text)) {
    return failure("not_found", safeFailureText(text), false);
  }
  if (
    /^Usage:|^Unknown \/mcp subcommand|Invalid --|^Missing value|^Server name required/i.test(text)
  ) {
    return failure("invalid_args", safeFailureText(text), false);
  }
  if (/failed|failure|could not connect|connection .* failed/i.test(text)) {
    return failure("omp_error", safeFailureText(text), true);
  }
  if (operation === "list" && /^No MCP servers configured\.$/i.test(text)) return undefined;
  return undefined;
}

function stableRevision(output: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < output.length; index += 1) {
    hash ^= output.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return `mcp-${hash.toString(16).padStart(8, "0")}`;
}

function originFromLocation(location: string): string | undefined {
  if (location === "(unknown)" || location === "(hidden)") return undefined;
  try {
    const parsed = new URL(location);
    if (parsed.username !== "" || parsed.password !== "") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function commandFromLocation(location: string): string | undefined {
  if (location === "(unknown)" || location === "(hidden)") return undefined;
  const first = location.trim().split(/\s+/, 1)[0];
  return first === undefined || first.length === 0 ? undefined : first;
}

function listServer(line: string): McpServerSummary | undefined {
  const match =
    /^(.*?) \| (stdio|http|sse) \| (enabled|disabled) \| (.*?) \[(user|project)\]$/.exec(line);
  if (!match) return undefined;
  const [, name, transport, enabledState, location, scope] = match;
  if (
    name === undefined ||
    transport === undefined ||
    enabledState === undefined ||
    location === undefined ||
    scope === undefined
  ) {
    return undefined;
  }
  const parsedName = McpServerName.safeParse(name);
  if (!parsedName.success) return undefined;
  const enabled = enabledState === "enabled";
  const summary = {
    name: parsedName.data,
    scope,
    transport,
    enabled,
    status: enabled ? "configured" : "disabled",
    ...(transport === "stdio"
      ? (() => {
          const command = commandFromLocation(location);
          return command === undefined ? {} : { command };
        })()
      : (() => {
          const url = originFromLocation(location);
          return url === undefined ? {} : { url };
        })()),
    auth: "unknown",
    source: { origin: scope, reloadRequired: true },
  } as const;
  const parsed = McpServerListResult.shape.servers.element.safeParse(summary);
  return parsed.success ? parsed.data : undefined;
}

/** Parses the exact v18.6.1 `/mcp list` ACP output into redacted browser DTOs. */
export function parseMcpServerListOutput(output: string): McpServerListResultValue {
  const normalized = sanitizeOutput(output).trim();
  if (normalized === "No MCP servers configured.") {
    return McpServerListResult.parse({ servers: [], revision: stableRevision(normalized) });
  }
  if (normalized.length === 0)
    throw outputFailure("list", output, "The command returned no list output.");
  const servers: McpServerSummary[] = [];
  const names = new Set<string>();
  for (const line of normalized.split(/\r?\n/)) {
    const server = listServer(line);
    if (server === undefined)
      throw outputFailure("list", output, `Unrecognized list row: ${safeFailureText(line)}`);
    if (names.has(server.name))
      throw outputFailure("list", output, `Duplicate server row: ${server.name}`);
    names.add(server.name);
    servers.push(server);
  }
  return McpServerListResult.parse({ servers, revision: stableRevision(normalized) });
}

function summaryForAdd(args: McpAddServerArgs): McpServerSummary {
  const parsed = addArgs(args);
  const transport = parsed.transport ?? (parsed.url === undefined ? "stdio" : "http");
  const summary = {
    name: parsed.name,
    scope: parsed.scope,
    transport,
    enabled: true,
    status: "configured",
    ...(parsed.command === undefined ? {} : { command: parsed.command.trim().split(/\s+/, 1)[0] }),
    ...(parsed.url === undefined ? {} : { url: new URL(parsed.url).origin }),
    auth: "none",
    source: { origin: parsed.scope, reloadRequired: true },
  } as const;
  return McpServerListResult.shape.servers.element.parse(summary);
}

function actionResult(
  operationId: string,
  status: McpServerActionResultValue["status"],
  server: McpServerSummary | null,
  message: string,
): McpServerActionResultValue {
  const boundedMessage =
    message.length > MAX_ACTION_MESSAGE_CHARS
      ? `${message.slice(0, MAX_ACTION_MESSAGE_CHARS - 1)}…`
      : message;
  return McpServerActionResult.parse({ operationId, status, server, message: boundedMessage });
}

/** Parses exact v18.6.1 success/error text for one typed lifecycle operation. */
export function parseMcpServerActionOutput(
  operation: Exclude<McpServerLifecycleOperation, "list" | "help">,
  args: McpServerActionArgsValue,
  output: string,
  addRequest?: McpAddServerArgs,
): McpServerActionResultValue {
  const normalized = sanitizeOutput(output).trim();
  const error = knownFailure(operation, normalized);
  if (error) throw error;
  if (normalized.length === 0)
    throw outputFailure(operation, output, "The command returned no operation output.");
  const name = args.name;
  switch (operation) {
    case "add": {
      const match = /^Added MCP server "([A-Za-z0-9][A-Za-z0-9._-]*)" \((user|project)\)\.$/.exec(
        normalized,
      );
      if (!match || match[1] !== name || addRequest === undefined) {
        throw outputFailure("add", output, "Expected the v18.6.1 add confirmation.");
      }
      return actionResult(args.operationId, "configured", summaryForAdd(addRequest), normalized);
    }
    case "remove": {
      const match =
        /^Removed server "([A-Za-z0-9][A-Za-z0-9._-]*)" from (user|project) config\.$/.exec(
          normalized,
        );
      if (!match || match[1] !== name || match[2] !== args.scope) {
        throw outputFailure("remove", output, "Expected the v18.6.1 remove confirmation.");
      }
      return actionResult(args.operationId, "disabled", null, normalized);
    }
    case "enable":
    case "disable": {
      const expectedState = operation === "enable" ? "enabled" : "disabled";
      const match =
        /^Server "([A-Za-z0-9][A-Za-z0-9._-]*)" (enabled|disabled)(?: \((user|project) config\))?\.$/.exec(
          normalized,
        );
      if (!match || match[1] !== name || match[2] !== expectedState) {
        throw outputFailure(operation, output, `Expected the v18.6.1 ${operation} confirmation.`);
      }
      return actionResult(
        args.operationId,
        operation === "enable" ? "configured" : "disabled",
        null,
        normalized,
      );
    }
    case "test": {
      const match =
        /^Server "([A-Za-z0-9][A-Za-z0-9._-]*)" connected \((\d+) tools\)\.(?:\n(?: {2}- .*\n?)*)?$/.exec(
          normalized,
        );
      if (!match || match[1] !== name) {
        throw outputFailure("test", output, "Expected the v18.6.1 connection-test report.");
      }
      return actionResult(args.operationId, "ready", null, normalized);
    }
    case "reconnect": {
      const match =
        /^(?:Reconnected to|Successfully connected to) "([A-Za-z0-9][A-Za-z0-9._-]*)"(?:\n? {2}Tools: \d+)?$/.exec(
          normalized,
        );
      if (!match || match[1] !== name) {
        throw outputFailure("reconnect", output, "Expected the v18.6.1 reconnect report.");
      }
      return actionResult(args.operationId, "ready", null, normalized);
    }
    case "reload": {
      if (
        normalized !== "MCP runtime reload requested." &&
        !/^MCP reload complete\n/.test(normalized)
      ) {
        throw outputFailure("reload", output, "Expected the v18.6.1 reload report.");
      }
      return actionResult(args.operationId, "configured", null, normalized);
    }
  }
}

function gatewayFailure(operation: string, error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  return failure("unavailable", `MCP ${operation} command gateway is unavailable.`, true);
}

function ensureResultOperation(result: CommandRunResult, command: SlashCommand): void {
  if (result.command !== command) {
    throw outputFailure(
      "command",
      result.command,
      `Gateway returned ${result.command} for ${command}.`,
    );
  }
}

async function runAction(
  gateway: OmpGatewayPort,
  threadId: ThreadId,
  operation: Exclude<McpServerLifecycleOperation, "list" | "help">,
  args: McpServerActionArgsValue,
  options: PortCallOptions | undefined,
  addRequest?: McpAddServerArgs,
): Promise<McpServerActionResultValue> {
  let command: SlashCommand;
  if (operation === "add") {
    if (addRequest === undefined) throw invalid("MCP add request is missing.");
    command = commandForAdd(addRequest);
  } else {
    command = commandForAction(operation, args);
  }
  const result = await gateway.run({ threadId, command }, options);
  ensureResultOperation(result, command);
  if (result.status === "aborted")
    throw failure("cancelled", `MCP ${operation} was cancelled.`, false);
  return parseMcpServerActionOutput(operation, args, outputText(result), addRequest);
}

/** Binds I1 lifecycle operations to A1.8's typed command gateway. */
export function createMcpServerPort(client: AppClient, threadId: ThreadId): McpServerLifecyclePort {
  const gateway = client.port(OmpCommandGateway);
  return Object.freeze({
    capability: I1_CAPABILITIES.mcp,
    async list(args?: McpServerListArgs, options?: PortCallOptions) {
      const command = commandForList(args);
      try {
        const result = await gateway.run({ threadId, command }, options);
        ensureResultOperation(result, command);
        if (result.status === "aborted")
          throw failure("cancelled", "MCP list was cancelled.", false);
        const parsed = parseMcpServerListOutput(outputText(result));
        if (args?.scope === undefined) return parsed;
        return McpServerListResult.parse({
          ...parsed,
          servers: parsed.servers.filter((server) => server.scope === args.scope),
        });
      } catch (error) {
        throw gatewayFailure("list", error);
      }
    },
    async add(args: McpAddServerArgs, options?: PortCallOptions) {
      const parsed = addArgs(args);
      try {
        return await runAction(gateway, threadId, "add", parsed, options, parsed);
      } catch (error) {
        throw gatewayFailure("add", error);
      }
    },
    async remove(args: McpServerActionArgsValue, options?: PortCallOptions) {
      const parsed = actionArgs(args);
      try {
        return await runAction(gateway, threadId, "remove", parsed, options);
      } catch (error) {
        throw gatewayFailure("remove", error);
      }
    },
    async enable(args: McpServerActionArgsValue, options?: PortCallOptions) {
      const parsed = actionArgs(args);
      try {
        return await runAction(gateway, threadId, "enable", parsed, options);
      } catch (error) {
        throw gatewayFailure("enable", error);
      }
    },
    async disable(args: McpServerActionArgsValue, options?: PortCallOptions) {
      const parsed = actionArgs(args);
      try {
        return await runAction(gateway, threadId, "disable", parsed, options);
      } catch (error) {
        throw gatewayFailure("disable", error);
      }
    },
    async toggle(
      args: McpServerActionArgsValue & { readonly enabled: boolean },
      options?: PortCallOptions,
    ) {
      const { enabled, ...rawArgs } = args;
      const parsed = actionArgs(rawArgs);
      try {
        return await runAction(gateway, threadId, enabled ? "enable" : "disable", parsed, options);
      } catch (error) {
        throw gatewayFailure(enabled ? "enable" : "disable", error);
      }
    },
    async test(args: McpServerActionArgsValue, options?: PortCallOptions) {
      const parsed = actionArgs(args);
      try {
        return await runAction(gateway, threadId, "test", parsed, options);
      } catch (error) {
        throw gatewayFailure("test", error);
      }
    },
    async reconnect(args: McpServerActionArgsValue, options?: PortCallOptions) {
      const parsed = actionArgs(args);
      try {
        return await runAction(gateway, threadId, "reconnect", parsed, options);
      } catch (error) {
        throw gatewayFailure("reconnect", error);
      }
    },
    async reload(args: McpServerActionArgsValue, options?: PortCallOptions) {
      const parsed = actionArgs(args);
      try {
        return await runAction(gateway, threadId, "reload", parsed, options);
      } catch (error) {
        throw gatewayFailure("reload", error);
      }
    },
    async help(options?: PortCallOptions) {
      const command = "/mcp help" as SlashCommand;
      try {
        const result = await gateway.run({ threadId, command }, options);
        ensureResultOperation(result, command);
        if (result.status === "aborted")
          throw failure("cancelled", "MCP help was cancelled.", false);
        const output = outputText(result);
        const error = knownFailure("help", output);
        if (error) throw error;
        if (output.length === 0)
          throw outputFailure("help", output, "The command returned no help output.");
        return Object.freeze(output.split(/\r?\n/));
      } catch (error) {
        throw gatewayFailure("help", error);
      }
    },
  });
}
