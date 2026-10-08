import {
  AppFailure,
  type CommandRunArgs,
  type CommandRunResult,
  type McpCommandActionArgs,
  McpCommandActionResult,
  type McpCommandActionResult as McpCommandActionResultValue,
  McpCommandHelpResult,
  type McpCommandHelpResult as McpCommandHelpResultValue,
  McpCommandPromptListResult,
  type McpCommandPromptListResult as McpCommandPromptListResultValue,
  McpCommandPromptSummary,
  McpCommandRemoteUrl,
  McpCommandResourceListResult,
  type McpCommandResourceListResult as McpCommandResourceListResultValue,
  McpCommandResourceSummary,
  McpCommandScope,
  type McpCommandServerListArgs,
  McpCommandServerListResult,
  type McpCommandServerListResult as McpCommandServerListResultValue,
  McpCommandServerName,
  McpCommandServerSummary,
  type McpCommandServerSummary as McpCommandServerSummaryValue,
  type McpCommandThreadArgs,
  McpCommandTransport,
  type PortCallOptions,
  PRIVATE_PATH_ROOTS,
  SlashCommand,
  type ThreadId,
} from "@omp-app/contracts";

const MAX_OUTPUTS = 256;
const MAX_RESULTS = 256;
// biome-ignore lint/complexity/useRegexLiterals: ANSI escape matching needs a string escape to avoid a source control character.
const ANSI_ESCAPE = new RegExp("\\x1b\\[[0-?]*[ -/]*[@-~]", "g");
// A scheme is at most 32 characters, so a long run of letters cannot make this match quadratic.
const URL_CREDENTIALS = /([a-z][a-z\d+.-]{0,31}:\/\/)[^/\s@]+@/gi;
const QUERY_CREDENTIALS =
  /([?&#](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|secret|password|authorization|api[_-]?key|credential|private[_-]?key|auth|sig|key|code|sessionid|x-amz-signature)=)[^&#\s]+/gi;
const HEADER_CREDENTIALS =
  /((?:"?(?:authorization|cookie)"?)\s*:\s*)(?:"[^"]*"|'[^']*'|[^,\r\n}]+)/gi;
const AUTH_SCHEME_CREDENTIALS = /\b(Bearer|Token)\s+[^\s,;)}\]]+/gi;
const SECRET_ASSIGNMENTS =
  /((?:"|')?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|token|secret|password|authorization|credential|private[_-]?key)(?:"|')?\s*[:=]\s*(?:"|')?)(?!<redacted>)[^"'\s,;}&]+/gi;
const BASIC_CREDENTIALS = /\bBasic\s+[A-Za-z0-9+/=]{12,}/gi;
const API_KEY_CREDENTIALS =
  /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:hf|gsk)_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gi;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_PATH = new RegExp(
  `(?<![\\w.>~-])(?:${PRIVATE_PATH_ROOTS.join("|")})(?:[/\\\\][^\\s"'<>|?*:]+)*(?![\\w.-])`,
  "g",
);
const WINDOWS_PATH = /(?<!\w)[A-Za-z]:(?:\\{1,2}|\/)[^\s"'<>|?*:]+/g;
const TUI_ONLY_MESSAGE =
  /requires OAuth or browser flows|requires the TUI client|only available in the TUI client/i;
const NO_MCP_SERVERS = "No MCP servers configured.";
const NO_PROMPTS = "No prompts available on connected servers.";
const NO_RESOURCES = "No resources available on connected servers.";
const LIST_COMMAND = SlashCommand.parse("/mcp list");
const PROMPTS_COMMAND = SlashCommand.parse("/mcp prompts");
const RESOURCES_COMMAND = SlashCommand.parse("/mcp resources");
const HELP_COMMAND = SlashCommand.parse("/mcp help");
const MCP_CAPABILITY = "host.mcp" as const;

export interface McpCommandRunner {
  run(args: CommandRunArgs, options?: PortCallOptions): Promise<CommandRunResult>;
}

/** Server-owned ACP command parsing. Browser modules receive only these validated summaries. */
export class McpCommandsService {
  private readonly gateway: McpCommandRunner;

  constructor(gateway: McpCommandRunner) {
    this.gateway = gateway;
  }

  async servers(
    args: McpCommandServerListArgs,
    options?: PortCallOptions,
  ): Promise<McpCommandServerListResultValue> {
    const output = await this.runCommand(args.threadId, LIST_COMMAND, options, "server list");
    const result = parseServerList(output);
    if (args.scope === undefined) return result;
    return McpCommandServerListResult.parse({
      ...result,
      servers: result.servers.filter((server) => server.scope === args.scope),
    });
  }

  async prompts(
    args: McpCommandThreadArgs,
    options?: PortCallOptions,
  ): Promise<McpCommandPromptListResultValue> {
    const output = await this.runCommand(args.threadId, PROMPTS_COMMAND, options, "prompt list");
    return parsePromptList(output);
  }

  async resources(
    args: McpCommandThreadArgs,
    options?: PortCallOptions,
  ): Promise<McpCommandResourceListResultValue> {
    const output = await this.runCommand(
      args.threadId,
      RESOURCES_COMMAND,
      options,
      "resource list",
    );
    return parseResourceList(output);
  }

  async help(
    args: McpCommandThreadArgs,
    options?: PortCallOptions,
  ): Promise<McpCommandHelpResultValue> {
    const output = await this.runCommand(args.threadId, HELP_COMMAND, options, "help");
    return parseHelp(output);
  }

  async action(
    args: McpCommandActionArgs,
    options?: PortCallOptions,
  ): Promise<McpCommandActionResultValue> {
    const command = commandForAction(args);
    const mutating = args.operation !== "test";
    const output = await this.runCommand(args.threadId, command, options, args.operation, mutating);
    return parseActionOutput(args, output);
  }

  private async runCommand(
    threadId: ThreadId,
    command: string,
    options: PortCallOptions | undefined,
    operation: string,
    mutating = false,
  ): Promise<string> {
    const parsedCommand = SlashCommand.parse(command);
    let result: CommandRunResult;
    try {
      result = await this.gateway.run({ threadId, command: parsedCommand }, options);
    } catch (error) {
      if (error instanceof AppFailure && error.appError.code === "cancelled" && mutating) {
        throw mutationCancelled(error);
      }
      if (error instanceof AppFailure) {
        if (error.appError.omp === undefined) throw error;
        throw new AppFailure({
          code: error.appError.code,
          message: `The MCP ${operation} command could not be completed.`,
          retryable: error.appError.retryable,
          ...(error.appError.capability === undefined
            ? {}
            : { capability: error.appError.capability }),
        });
      }
      throw failure("internal", `The MCP ${operation} command could not be completed.`, false);
    }
    const output = parseOutput(result, parsedCommand, operation, mutating);
    if (isCommandFailure(output)) throw classifyFailure(output, undefined);
    return output;
  }
}

function commandForAction(args: McpCommandActionArgs): string {
  switch (args.operation) {
    case "add":
      return addCommand(args);
    case "remove":
      return `/mcp remove ${serverNameWord(args.name)} --scope ${args.scope}`;
    case "enable":
    case "disable":
    case "test":
      return `/mcp ${args.operation} ${serverNameWord(args.name)}`;
    case "reload":
      return "/mcp reload";
  }
}

function addCommand(args: Extract<McpCommandActionArgs, { operation: "add" }>): string {
  const hasUrl = args.url !== undefined;
  const hasCommand = args.command !== undefined;
  if (hasUrl === hasCommand)
    throw failure("invalid_args", "Choose either a remote URL or a local command.", false);
  if (args.args !== undefined && !hasCommand) {
    throw failure("invalid_args", "Local command arguments require a local command.", false);
  }
  if (args.args !== undefined) {
    if (args.args.length > 128)
      throw failure("invalid_args", "Too many local command arguments.", false);
    if (
      args.args.some((arg) =>
        /(?:^|[-_])(token|secret|password|api[-_]?key|authorization)(?:$|[-_=])/i.test(arg),
      )
    ) {
      throw failure(
        "invalid_args",
        "Local command arguments must not include options for passing secrets.",
        false,
      );
    }
  }

  const words = ["/mcp", "add", serverNameWord(args.name), "--scope", args.scope];
  if (args.url !== undefined) {
    const url = validatedRemoteUrl(args.url);
    const transport = args.transport ?? "http";
    if (transport !== "http" && transport !== "sse") {
      throw failure(
        "invalid_args",
        "Choose HTTP or server-sent events for a remote server.",
        false,
      );
    }
    words.push("--url", shellWord(url, "MCP URL"), "--transport", transport);
  } else {
    const transport = args.transport ?? "stdio";
    if (transport !== "stdio") {
      throw failure("invalid_args", "Choose the local command option for a local server.", false);
    }
    if (args.command === undefined)
      throw failure("invalid_args", "A local command is required.", false);
    words.push("--", shellWord(args.command, "MCP command"));
    for (const argument of args.args ?? []) words.push(shellWord(argument, "MCP command argument"));
  }
  return words.join(" ");
}

function parseServerList(output: string): McpCommandServerListResultValue {
  const normalized = output.trim();
  if (normalized === NO_MCP_SERVERS) {
    return McpCommandServerListResult.parse({ servers: [], revision: stableRevision(normalized) });
  }
  if (normalized.length === 0) throw outputFailure("server list");
  const servers: McpCommandServerSummaryValue[] = [];
  const seen = new Set<string>();
  let skippedCount = 0;
  for (const line of normalized.split(/\r?\n/)) {
    const server = parseServerRow(line);
    if (server === undefined || seen.has(server.name) || servers.length >= MAX_RESULTS) {
      skippedCount += 1;
      continue;
    }
    seen.add(server.name);
    servers.push(server);
  }
  return McpCommandServerListResult.parse({
    servers,
    revision: stableRevision(normalized),
    skippedCount,
    truncated: skippedCount > 0,
  });
}

/** Mirrors the v18.6.1 `/mcp list` formatter: packages/coding-agent/src/slash-commands/helpers/mcp.ts:370-412. */
function parseServerRow(line: string): McpCommandServerSummaryValue | undefined {
  const match =
    /^(.*?) \| (stdio|http|sse) \| (enabled|disabled) \| (.*?) \[(user|project)\]$/.exec(line);
  if (!match) return undefined;
  const [, name, transportText, enabledText, location, scopeText] = match;
  const parsedName = McpCommandServerName.safeParse(sanitizeOutput(name ?? ""));
  const transport = McpCommandTransport.safeParse(transportText);
  const scope = McpCommandScope.safeParse(scopeText);
  if (!parsedName.success || !transport.success || !scope.success || location === undefined)
    return undefined;
  const enabled = enabledText === "enabled";
  const summary = {
    name: parsedName.data,
    scope: scope.data,
    transport: transport.data,
    enabled,
    status: enabled ? "configured" : "disabled",
    ...(transport.data === "stdio" ? commandFromLocation(location) : urlFromLocation(location)),
    auth: "unknown",
    source: { origin: scope.data, reloadRequired: true },
  };
  const parsed = McpCommandServerSummary.safeParse(summary);
  return parsed.success ? parsed.data : undefined;
}

function commandFromLocation(location: string): { readonly command?: string } {
  if (location === "(unknown)" || location === "(hidden)") return {};
  const command = executableName(location);
  return command === undefined ? {} : { command: boundedText(sanitizeOutput(command), 256) };
}

function urlFromLocation(location: string): { readonly url?: string } {
  if (location === "(unknown)" || location === "(hidden)") return {};
  try {
    const url = new URL(location);
    if (url.username !== "" || url.password !== "") return {};
    return { url: url.origin };
  } catch {
    return {};
  }
}
/** Mirrors the v18.6.1 `/mcp prompts` formatter: packages/coding-agent/src/slash-commands/helpers/mcp.ts:265-276. */
function parsePromptList(output: string): McpCommandPromptListResultValue {
  if (output === NO_MCP_SERVERS || output === NO_PROMPTS) {
    return McpCommandPromptListResult.parse({ prompts: [], revision: stableRevision(output) });
  }
  if (output.length === 0) throw outputFailure("prompt list");
  const prompts: McpCommandPromptListResultValue["prompts"] = [];
  const seen = new Set<string>();
  let current: { server: string; name: string; description?: string } | undefined;
  let skippedCount = 0;
  let truncated = false;

  const finishPrompt = (): void => {
    if (current === undefined) return;
    const id = stableIdentifier("mcp-prompt", `${current.server}\u0000${current.name}`);
    const name = sanitizeOutput(current.name);
    const description =
      current.description === undefined ? undefined : sanitizeOutput(current.description);
    if (name.length > 256 || (description !== undefined && description.length > 2_048)) {
      truncated = true;
    }
    const summary = McpCommandPromptSummary.safeParse({
      id,
      server: sanitizeOutput(current.server),
      name: boundedText(name, 256),
      ...(description === undefined ? {} : { description: boundedText(description, 2_048) }),
    });
    if (!summary.success || seen.has(id) || prompts.length >= MAX_RESULTS) {
      skippedCount += 1;
    } else {
      seen.add(id);
      prompts.push(summary.data);
    }
    current = undefined;
  };

  for (const line of output.split(/\r?\n/)) {
    const prompt = parsePromptRow(line);
    if (prompt !== undefined) {
      finishPrompt();
      current = prompt;
    } else if (current !== undefined) {
      current.description =
        current.description === undefined ? line : `${current.description}\n${line}`;
    } else {
      skippedCount += 1;
    }
  }
  finishPrompt();
  return McpCommandPromptListResult.parse({
    prompts,
    revision: stableRevision(output),
    skippedCount,
    truncated: truncated || skippedCount > 0,
  });
}

function parsePromptRow(
  line: string,
): { server: string; name: string; description?: string } | undefined {
  const separator = line.indexOf("/");
  if (separator < 1) return undefined;
  const server = McpCommandServerName.safeParse(line.slice(0, separator));
  const promptInfo = line.slice(separator + 1);
  if (!server.success || promptInfo.length === 0) return undefined;
  const descriptionAt = promptInfo.indexOf(" — ");
  const name = descriptionAt < 0 ? promptInfo : promptInfo.slice(0, descriptionAt);
  // A prompt name is one word, like a server name, so a description line with a slash is not a row.
  if (name.length === 0 || /\s/.test(name)) return undefined;
  const description = descriptionAt < 0 ? undefined : promptInfo.slice(descriptionAt + 3);
  return {
    server: server.data,
    name,
    ...(description === undefined ? {} : { description }),
  };
}

/** Mirrors the v18.6.1 `/mcp resources` formatter: packages/coding-agent/src/slash-commands/helpers/mcp.ts:252-263. */
function parseResourceList(output: string): McpCommandResourceListResultValue {
  if (output === NO_MCP_SERVERS || output === NO_RESOURCES) {
    return McpCommandResourceListResult.parse({ resources: [], revision: stableRevision(output) });
  }
  if (output.length === 0) throw outputFailure("resource list");
  const resources: McpCommandResourceListResultValue["resources"] = [];
  const seen = new Set<string>();
  let skippedCount = 0;
  let truncated = false;
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("/");
    const server = McpCommandServerName.safeParse(line.slice(0, separator));
    const rawUri = line.slice(separator + 1);
    if (separator < 1 || !server.success || rawUri.length === 0) {
      skippedCount += 1;
      continue;
    }
    const id = stableIdentifier("mcp-resource", `${server.data}\u0000${rawUri}`);
    if (seen.has(id) || resources.length >= MAX_RESULTS) {
      skippedCount += 1;
      continue;
    }
    const safeUri = sanitizeResourceUri(rawUri);
    const name = resourceName(safeUri);
    if (safeUri.length > 2_048 || name.length > 256) truncated = true;
    const summary = McpCommandResourceSummary.safeParse({
      id,
      server: sanitizeOutput(server.data),
      uri: boundedText(safeUri, 2_048),
      name: boundedText(name, 256),
    });
    if (!summary.success) {
      skippedCount += 1;
      continue;
    }
    seen.add(id);
    resources.push(summary.data);
  }
  return McpCommandResourceListResult.parse({
    resources,
    revision: stableRevision(output),
    skippedCount,
    truncated: truncated || skippedCount > 0,
  });
}

function resourceName(uri: string): string {
  const path = uri.split(/[?#]/, 1)[0] ?? uri;
  const leaf = path.split(/[\\/]/).filter(Boolean).at(-1);
  const name = leaf ?? path;
  return name || "resource";
}

function sanitizeResourceUri(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  const scheme = /^([a-z][a-z\d+.-]*:\/\/)/i.exec(withoutQuery)?.[1] ?? "";
  let path = withoutQuery.slice(scheme.length);
  if (scheme.toLowerCase() === "file://") path = path.replace(/^\/(?=[a-z]:[\\/])/i, "");
  const privateRoot = PRIVATE_PATH_ROOTS.find(
    (root) =>
      path.startsWith(root) &&
      (path.length === root.length || path[root.length] === "/" || path[root.length] === "\\"),
  );
  const privateWindowsPath = /^[a-z]:[\\/]/i.test(path);
  if (privateRoot !== undefined || privateWindowsPath) {
    const leaf = path.split(/[\\/]/).filter(Boolean).at(-1);
    return `${scheme}<private-path>${leaf === undefined ? "" : `/${sanitizeOutput(leaf)}`}`;
  }
  return sanitizeOutput(withoutQuery);
}

function executableName(value: string): string | undefined {
  const normalized = value.trim().replaceAll("\\", "/");
  const command = normalized.slice(normalized.lastIndexOf("/") + 1);
  return command.length === 0 ? undefined : command;
}

function boundedText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function parseActionOutput(
  args: McpCommandActionArgs,
  output: string,
): McpCommandActionResultValue {
  const name = "name" in args ? args.name : undefined;
  switch (args.operation) {
    case "add": {
      const match = /^Added MCP server "([^"\r\n]+)" \((user|project)\)\.$/.exec(output);
      if (match?.[1] === args.name && match[2] === args.scope) {
        return McpCommandActionResult.parse({
          operationId: args.operationId,
          status: "configured",
          server: summaryForAdd(args),
          message: "The MCP server was added.",
        });
      }
      break;
    }
    case "remove": {
      const match = /^Removed server "([^"\r\n]+)" from (user|project) config\.$/.exec(output);
      if (match?.[1] === args.name && match[2] === args.scope) {
        return McpCommandActionResult.parse({
          operationId: args.operationId,
          status: "disabled",
          server: null,
          message: "The MCP server was removed.",
        });
      }
      break;
    }
    case "enable":
    case "disable": {
      const expected = args.operation === "enable" ? "enabled" : "disabled";
      const match =
        /^Server "([^"\r\n]+)" (enabled|disabled)(?: \((user|project) config\))?\.$/.exec(output);
      if (match?.[1] === args.name && match[2] === expected) {
        const actualScope = match[3] ?? "user";
        if (actualScope !== args.scope) {
          throw failure(
            "conflict",
            "omp changed a different MCP configuration scope. Refresh the server list before trying again.",
            false,
          );
        }
        return McpCommandActionResult.parse({
          operationId: args.operationId,
          status: args.operation === "enable" ? "configured" : "disabled",
          server: null,
          message:
            args.operation === "enable"
              ? "The MCP server was enabled."
              : "The MCP server was disabled.",
        });
      }
      break;
    }
    case "test": {
      const match =
        /^Server "([^"\r\n]+)" connected \((\d+) tools?\)\.(?:\n(?: {2}- .*\n?)*)?$/.exec(output);
      if (match?.[1] === args.name) {
        return McpCommandActionResult.parse({
          operationId: args.operationId,
          status: "ready",
          server: null,
          message: `Connected to the MCP server. Found ${match[2]} ${match[2] === "1" ? "tool" : "tools"}.`,
        });
      }
      break;
    }
    case "reload":
      if (output === "MCP runtime reload requested." || /^MCP reload complete\n/.test(output)) {
        return McpCommandActionResult.parse({
          operationId: args.operationId,
          status: "configured",
          server: null,
          message: "MCP servers reloaded.",
        });
      }
      break;
  }

  throw classifyFailure(output, name);
}

function summaryForAdd(
  args: Extract<McpCommandActionArgs, { operation: "add" }>,
): McpCommandServerSummaryValue {
  const transport = args.transport ?? (args.url === undefined ? "stdio" : "http");
  const command = args.command === undefined ? undefined : executableName(args.command);
  const url = args.url === undefined ? undefined : new URL(validatedRemoteUrl(args.url)).origin;
  const summary = McpCommandServerSummary.safeParse({
    name: args.name,
    scope: args.scope,
    transport,
    enabled: true,
    status: "configured",
    ...(command === undefined ? {} : { command: boundedText(sanitizeOutput(command), 256) }),
    ...(url === undefined ? {} : { url }),
    auth: "none",
    source: { origin: args.scope, reloadRequired: true },
  });
  if (!summary.success) throw failure("invalid_args", "The MCP server details are invalid.", false);
  return summary.data;
}
function isCommandFailure(output: string): boolean {
  return (
    TUI_ONLY_MESSAGE.test(output) ||
    /^Server ".+" not found(?: in user or project config)?\.$/i.test(output) ||
    /^Server ".+" not found\. Run \/mcp list to see configured servers\.$/i.test(output) ||
    /^Usage:|^Unknown \/mcp subcommand|^Invalid --|^Missing value|^Server name required|^Provide --|^Use either /i.test(
      output,
    ) ||
    /^Connection to ".+" failed:/i.test(output) ||
    /^Failed to (?:add|remove|enable|disable|list) (?:MCP )?servers?/i.test(output)
  );
}

function classifyFailure(output: string, name: string | undefined): AppFailure {
  if (TUI_ONLY_MESSAGE.test(output)) {
    return failure(
      "unavailable",
      "Complete this MCP sign-in or reconnect in the omp terminal.",
      false,
    );
  }
  if (/^Failed to add server:\s*Server ".+" already exists(?: in .+)?$/i.test(output)) {
    return failure(
      "conflict",
      "A server with that name already exists in this configuration.",
      false,
    );
  }
  if (
    /^Server ".+" not found(?: in user or project config)?\.$/i.test(output) ||
    /^Server ".+" not found\. Run \/mcp list to see configured servers\.$/i.test(output)
  ) {
    return failure(
      "not_found",
      "No MCP server with that name exists or is enabled in the selected configuration.",
      false,
    );
  }
  if (
    /^Usage:|^Unknown \/mcp subcommand|^Invalid --|^Missing value|^Server name required|^Provide --|^Use either /i.test(
      output,
    )
  ) {
    return failure("invalid_args", "The MCP server command arguments are invalid.", false);
  }
  if (/^Connection to ".+" failed:/i.test(output)) {
    return failure(
      "omp_error",
      "Could not connect to the MCP server. Check its settings and try again.",
      true,
    );
  }
  if (/^Failed to (?:add|remove|enable|disable|list) (?:MCP )?servers?/i.test(output)) {
    return failure("omp_error", "The MCP server command could not be completed.", false);
  }
  return failure(
    "internal",
    name === undefined
      ? "omp returned an unrecognized MCP command response."
      : "omp returned an unrecognized response for this MCP server.",
    false,
  );
}

function validatedRemoteUrl(value: string): string {
  const parsed = McpCommandRemoteUrl.safeParse(value.trim());
  if (!parsed.success) {
    throw failure(
      "invalid_args",
      "Enter an HTTP(S) server address without credentials, query strings or fragments.",
      false,
    );
  }
  return new URL(parsed.data).toString();
}

function shellWord(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 1_024 || trimmed.includes("\u0000")) {
    throw failure("invalid_args", `${label} is empty or too long.`, false);
  }
  if (/\r|\n/.test(trimmed)) throw failure("invalid_args", `${label} must be one line.`, false);
  if (/\s/.test(trimmed) || /['"\\$`]/.test(trimmed)) {
    return `'${trimmed.replaceAll("'", "'\"'\"'")}'`;
  }
  return trimmed;
}

/** omp's `/mcp` subcommands read a server name as one word, so a name omp could not address is refused. */
function serverNameWord(value: string): string {
  if (!McpCommandServerName.safeParse(value).success) {
    throw failure(
      "invalid_args",
      "Use letters, digits, '.', ':', '-' or '_' in an MCP server name; spaces are not allowed.",
      false,
    );
  }
  return shellWord(value, "MCP server name");
}
function parseHelp(output: string): McpCommandHelpResultValue {
  if (output.length === 0) throw outputFailure("help");
  const lines = output
    .split(/\r?\n/)
    .slice(0, MAX_RESULTS)
    .map((line) => boundedText(sanitizeOutput(line), 2_048));
  if (lines[0] !== undefined) lines[0] = lines[0].replace(/ \(ACP mode\)$/, "");
  return McpCommandHelpResult.parse({ lines });
}

function parseOutput(
  result: CommandRunResult,
  command: SlashCommand,
  operation: string,
  mutating: boolean,
): string {
  if (result.command !== command)
    throw failure("internal", `The MCP ${operation} result did not match.`, false);
  if (result.status === "aborted") {
    if (mutating) throw mutationCancelled();
    throw failure("cancelled", `The MCP ${operation} request was cancelled.`, false);
  }
  if (result.outputs.length > MAX_OUTPUTS) {
    throw failure("internal", `The MCP ${operation} response exceeded its supported size.`, false);
  }
  return result.outputs
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function sanitizeOutput(value: string): string {
  return value
    .replace(ANSI_ESCAPE, "")
    .replace(URL_CREDENTIALS, "$1<redacted>@")
    .replace(HEADER_CREDENTIALS, '$1"<redacted>"')
    .replace(QUERY_CREDENTIALS, "$1<redacted>")
    .replace(AUTH_SCHEME_CREDENTIALS, "$1 <redacted>")
    .replace(SECRET_ASSIGNMENTS, "$1<redacted>")
    .replace(API_KEY_CREDENTIALS, "<redacted>")
    .replace(BASIC_CREDENTIALS, "Basic <redacted>")
    .replace(PRIVATE_KEY_BLOCK, "<redacted>")
    .replace(PRIVATE_PATH, "<private-path>")
    .replace(WINDOWS_PATH, "<private-path>");
}

function outputFailure(operation: string): AppFailure {
  return failure("internal", `omp returned an unrecognized MCP ${operation} response.`, false);
}

function mutationCancelled(cause?: AppFailure): AppFailure {
  return new AppFailure(
    {
      code: "cancelled",
      message:
        "This change may already have been applied. Refresh the server list before trying again.",
      retryable: false,
      capability: MCP_CAPABILITY,
    },
    cause === undefined ? undefined : { cause },
  );
}

function failure(
  code:
    | "cancelled"
    | "conflict"
    | "internal"
    | "invalid_args"
    | "not_found"
    | "omp_error"
    | "unavailable",
  message: string,
  retryable: boolean,
  capability: typeof MCP_CAPABILITY = MCP_CAPABILITY,
): AppFailure {
  return new AppFailure({ code, message, retryable, capability });
}

function stableRevision(text: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return `mcp-${hash.toString(16).padStart(8, "0")}`;
}

function stableIdentifier(prefix: string, key: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${prefix}-${hash.toString(16).padStart(16, "0")}`;
}
