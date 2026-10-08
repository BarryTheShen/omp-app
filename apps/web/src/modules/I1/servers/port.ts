import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  McpCommandActionArgs,
  type McpCommandRemoteUrl,
  McpCommandsPort,
  type PortCallOptions,
  type ThreadId,
} from "@omp-app/contracts";
import {
  I1_CAPABILITIES,
  type McpPortCallOptions,
  McpServerActionArgs,
  type McpServerActionArgs as McpServerActionArgsValue,
  McpServerActionResult,
  type McpServerActionResult as McpServerActionResultValue,
  McpServerListArgs,
  McpServerListResult,
  type McpServerListResult as McpServerListResultValue,
  type McpServerPort,
  McpTransport,
} from "../contract";

export type McpAddServerArgs = McpServerActionArgsValue & {
  /** Transport is optional only for compatibility with McpServerActionArgs; add validates it. */
  readonly transport?: McpTransport;
  /** HTTP/SSE endpoint; paths are allowed, but credentials, query strings and fragments are refused. */
  readonly url?: McpCommandRemoteUrl;
  /** Stdio executable, without environment or credential expansion. */
  readonly command?: string;
  /** Safe stdio arguments; credential-bearing flags are refused. */
  readonly args?: readonly string[];
};

type McpServerLifecycleOperation =
  | "list"
  | "add"
  | "remove"
  | "enable"
  | "disable"
  | "test"
  | "reload"
  | "help";

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
function checkedCommandArgs(value: unknown): McpCommandActionArgs {
  const parsed = McpCommandActionArgs.safeParse(value);
  if (!parsed.success) throw invalid("Invalid MCP server action arguments.");
  return parsed.data;
}

function validatedActionArgs(value: McpServerActionArgsValue): McpServerActionArgsValue {
  const parsed = McpServerActionArgs.safeParse(value);
  if (!parsed.success) throw invalid("Invalid MCP server action arguments.");
  if (parsed.data.scope === "foreign") {
    throw invalid("Choose a user or project configuration.");
  }
  return parsed.data;
}

function validatedAddArgs(value: McpAddServerArgs): McpAddServerArgs {
  const { transport, url, command, args, ...base } = value;
  const parsed = validatedActionArgs(base);
  if (transport !== undefined && !McpTransport.safeParse(transport).success) {
    throw invalid("Choose a supported MCP server transport.");
  }
  const hasUrl = url !== undefined;
  const hasCommand = command !== undefined;
  if (hasUrl === hasCommand)
    throw invalid("Choose either a remote server address or a local command.");
  if (hasUrl && transport !== "http" && transport !== "sse") {
    throw invalid("Choose HTTP or server-sent events for a remote server.");
  }
  if (hasCommand && transport !== undefined && transport !== "stdio") {
    throw invalid("Choose the local command option for a local server.");
  }
  if (args !== undefined && !hasCommand) {
    throw invalid("Local command arguments require a local command.");
  }
  return {
    ...value,
    ...parsed,
    ...(url === undefined ? {} : { url: url.trim() }),
  };
}

function commandArgsForAction(
  threadId: ThreadId,
  operation: Exclude<McpServerLifecycleOperation, "list" | "help">,
  value: McpServerActionArgsValue,
  addRequest?: McpAddServerArgs,
) {
  if (operation === "add") {
    if (addRequest === undefined) throw invalid("The MCP server details are missing.");
    const add = validatedAddArgs(addRequest);
    return checkedCommandArgs({
      threadId,
      operation,
      operationId: add.operationId,
      name: add.name,
      scope: add.scope,
      ...(add.transport === undefined ? {} : { transport: add.transport }),
      ...(add.url === undefined ? {} : { url: add.url }),
      ...(add.command === undefined ? {} : { command: add.command }),
      ...(add.args === undefined ? {} : { args: [...add.args] }),
    });
  }

  const args = validatedActionArgs(value);
  if (operation === "remove" || operation === "disable") {
    if (args.confirmed !== true)
      throw invalid("Confirm before removing or disabling an MCP server.");
  }
  switch (operation) {
    case "remove":
      return checkedCommandArgs({
        threadId,
        operation,
        operationId: args.operationId,
        name: args.name,
        scope: args.scope,
        confirmed: true,
      });
    case "enable":
    case "disable":
    case "test":
      return checkedCommandArgs({
        threadId,
        operation,
        operationId: args.operationId,
        name: args.name,
        scope: args.scope,
        ...(operation === "disable" ? { confirmed: true } : {}),
      });
    case "reload":
      return checkedCommandArgs({
        threadId,
        operation,
        operationId: args.operationId,
      });
  }
}

async function invoke<T>(fallback: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    throw new AppFailure(
      {
        code: "unavailable",
        message: fallback,
        retryable: false,
        capability: I1_CAPABILITIES.mcp,
      },
      { cause: error },
    );
  }
}

/** Binds I1 lifecycle operations to A1's typed MCP command port. */
export function createMcpServerPort(client: AppClient, threadId: ThreadId): McpServerLifecyclePort {
  const commands = client.port(McpCommandsPort);
  const runAction = async (
    operation: Exclude<McpServerLifecycleOperation, "list" | "help">,
    args: McpServerActionArgsValue,
    options?: PortCallOptions,
    addRequest?: McpAddServerArgs,
  ): Promise<McpServerActionResultValue> => {
    const commandArgs = commandArgsForAction(threadId, operation, args, addRequest);
    const result = await invoke("MCP server changes are unavailable.", () =>
      commands.action(commandArgs, options),
    );
    const parsed = McpServerActionResult.safeParse(result);
    if (!parsed.success) {
      throw new AppFailure({
        code: "internal",
        message: "The MCP server returned a result this app cannot display safely.",
        retryable: false,
        capability: I1_CAPABILITIES.mcp,
      });
    }
    return parsed.data;
  };

  return Object.freeze({
    capability: I1_CAPABILITIES.mcp,
    async list(
      args?: McpServerListArgs,
      options?: PortCallOptions,
    ): Promise<McpServerListResultValue> {
      const parsedArgs = args === undefined ? undefined : McpServerListArgs.parse(args);
      const scope = parsedArgs?.scope;
      if (scope === "foreign") throw invalid("Choose a user or project configuration.");
      const result = await invoke("MCP server details are unavailable.", () =>
        commands.servers(
          {
            threadId,
            ...(scope === undefined ? {} : { scope }),
          },
          options,
        ),
      );
      const parsed = McpServerListResult.safeParse(result);
      if (!parsed.success) {
        throw new AppFailure({
          code: "internal",
          message: "The MCP server list cannot be displayed safely.",
          retryable: false,
          capability: I1_CAPABILITIES.mcp,
        });
      }
      return parsed.data;
    },
    async add(args: McpAddServerArgs, options?: PortCallOptions) {
      const parsed = validatedAddArgs(args);
      return runAction("add", parsed, options, parsed);
    },
    async remove(args: McpServerActionArgsValue, options?: PortCallOptions) {
      return runAction("remove", args, options);
    },
    async enable(args: McpServerActionArgsValue, options?: PortCallOptions) {
      return runAction("enable", args, options);
    },
    async disable(args: McpServerActionArgsValue, options?: PortCallOptions) {
      return runAction("disable", args, options);
    },
    async toggle(
      args: McpServerActionArgsValue & { readonly enabled: boolean },
      options?: PortCallOptions,
    ) {
      const { enabled, ...action } = args;
      return runAction(enabled ? "enable" : "disable", action, options);
    },
    async test(args: McpServerActionArgsValue, options?: PortCallOptions) {
      return runAction("test", args, options);
    },
    async reconnect(args: McpServerActionArgsValue, _options?: PortCallOptions) {
      validatedActionArgs(args);
      throw new AppFailure({
        code: "unavailable",
        message: "Reconnect this MCP server in the omp terminal; this app cannot reconnect it.",
        retryable: false,
        capability: I1_CAPABILITIES.mcpReconnect,
      });
    },
    async reload(args: McpServerActionArgsValue, options?: PortCallOptions) {
      return runAction("reload", args, options);
    },
    async help(options?: PortCallOptions) {
      const result = await invoke("MCP help is unavailable.", () =>
        commands.help({ threadId }, options),
      );
      return Object.freeze([...result.lines]);
    },
  });
}
