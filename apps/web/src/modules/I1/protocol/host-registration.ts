import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  type OmpWire,
  type RpcSessionClient,
  RpcSessionPort,
  type ThreadId,
} from "@omp-app/contracts";
import type { McpPortCallOptions } from "../contract";
import {
  HostToolDefinition,
  type HostToolDefinition as HostToolDefinitionValue,
  HostToolName,
  type HostToolPort,
  HostToolRegistrationResult,
  type HostToolRegistrationResult as HostToolRegistrationResultValue,
  HostUriDefinition,
  type HostUriDefinition as HostUriDefinitionValue,
  type HostUriPort,
  HostUriRegistrationResult,
  type HostUriRegistrationResult as HostUriRegistrationResultValue,
  HostUriScheme,
  I1_CAPABILITIES,
  toI1Failure,
} from "../contract";

const MAX_HOST_REGISTRATIONS = 256;
const HostToolDefinitions = HostToolDefinition.array().max(MAX_HOST_REGISTRATIONS);
const HostUriDefinitions = HostUriDefinition.array().max(MAX_HOST_REGISTRATIONS);

export interface HostRegistrationOptions {
  readonly client: AppClient;
  readonly threadId: ThreadId;
  readonly capabilities?: CapabilityMap;
}

/** Owns one AP9 registration set; A0 merges owners for the thread's omp process. */
export function createHostToolPort(options: HostRegistrationOptions): HostToolPort {
  const rpc = options.client.port(RpcSessionPort) as RpcSessionClient;
  const registrationOwner = crypto.randomUUID();
  const registrations = new Map<string, HostToolDefinitionValue>();
  const runExclusive = createSerialExecutor();

  const apply = async (
    tools: readonly HostToolDefinitionValue[],
    callOptions?: McpPortCallOptions,
  ): Promise<HostToolRegistrationResultValue> => {
    requireCapability(options.capabilities, I1_CAPABILITIES.hostTools);
    const wireTools = tools.map(toWireTool);
    try {
      const result = await rpc.send(
        {
          threadId: options.threadId,
          registrationOwner,
          command: { type: "set_host_tools", tools: wireTools },
        },
        callOptions,
      );
      const parsed = HostToolRegistrationResult.safeParse({ names: result.toolNames });
      if (!parsed.success) throw invalid("omp returned tool details this app cannot use.");
      const returned = new Set(parsed.data.names);
      registrations.clear();
      for (const tool of tools) {
        if (returned.has(tool.name)) registrations.set(tool.name, tool);
      }
      return parsed.data;
    } catch (error) {
      throw toI1Failure(error, "Tools could not be made available to omp.");
    }
  };

  return {
    async setTools(rawTools, callOptions) {
      const tools = parseTools(rawTools);
      return runExclusive(() => apply(tools, callOptions));
    },
    async unregister(rawName, callOptions) {
      const parsedName = HostToolName.safeParse(rawName);
      if (!parsedName.success) throw invalid("Invalid tool name.");
      return runExclusive(async () => {
        if (!registrations.has(parsedName.data)) return;
        const remaining = [...registrations.values()].filter(
          (tool) => tool.name !== parsedName.data,
        );
        await apply(remaining, callOptions);
      });
    },
  };
}

/** Owns one URI registration set; A0 merges owners for the thread's omp process. */
export function createHostUriPort(options: HostRegistrationOptions): HostUriPort {
  const rpc = options.client.port(RpcSessionPort) as RpcSessionClient;
  const registrationOwner = crypto.randomUUID();
  const registrations = new Map<string, HostUriDefinitionValue>();
  const runExclusive = createSerialExecutor();

  const apply = async (
    schemes: readonly HostUriDefinitionValue[],
    callOptions?: McpPortCallOptions,
  ): Promise<HostUriRegistrationResultValue> => {
    requireCapability(options.capabilities, I1_CAPABILITIES.hostUris);
    const wireSchemes = schemes.map(toWireScheme);
    try {
      const result = await rpc.send(
        {
          threadId: options.threadId,
          registrationOwner,
          command: { type: "set_host_uri_schemes", schemes: wireSchemes },
        },
        callOptions,
      );
      const parsed = HostUriRegistrationResult.safeParse({ schemes: result.schemes });
      if (!parsed.success) throw invalid("omp returned address details this app cannot use.");
      const returned = new Set(parsed.data.schemes);
      registrations.clear();
      for (const scheme of schemes) {
        if (returned.has(scheme.scheme)) registrations.set(scheme.scheme, scheme);
      }
      return parsed.data;
    } catch (error) {
      throw toI1Failure(error, "Addresses could not be made available to omp.");
    }
  };

  return {
    async setSchemes(rawSchemes, callOptions) {
      const schemes = parseSchemes(rawSchemes);
      return runExclusive(() => apply(schemes, callOptions));
    },
    async unregister(rawScheme, callOptions) {
      const parsedScheme = HostUriScheme.safeParse(rawScheme);
      if (!parsedScheme.success) throw invalid("Invalid address name.");
      return runExclusive(async () => {
        if (!registrations.has(parsedScheme.data)) return;
        const remaining = [...registrations.values()].filter(
          (scheme) => scheme.scheme !== parsedScheme.data,
        );
        await apply(remaining, callOptions);
      });
    },
  };
}

function parseTools(
  rawTools: readonly HostToolDefinitionValue[],
): readonly HostToolDefinitionValue[] {
  const parsed = HostToolDefinitions.safeParse(rawTools);
  if (!parsed.success) throw invalid("Enter valid tool details.");
  const names = new Set<string>();
  for (const tool of parsed.data) {
    if (names.has(tool.name)) throw invalid("Each tool needs a different name.");
    names.add(tool.name);
  }
  return cloneTools(parsed.data);
}

function parseSchemes(
  rawSchemes: readonly HostUriDefinitionValue[],
): readonly HostUriDefinitionValue[] {
  const parsed = HostUriDefinitions.safeParse(rawSchemes);
  if (!parsed.success) throw invalid("Enter valid address details.");
  const names = new Set<string>();
  for (const scheme of parsed.data) {
    if (names.has(scheme.scheme)) throw invalid("Each address name must be different.");
    names.add(scheme.scheme);
    if (new Set(scheme.operations).size !== scheme.operations.length) {
      throw invalid("Do not repeat an operation for an address.");
    }
    if (!scheme.operations.includes("read")) {
      throw new AppFailure({
        code: "unavailable",
        message: "This omp version can only use address types that support reading.",
        retryable: false,
        capability: "upstream.mcp-uri-write-only",
      });
    }
  }
  return parsed.data;
}
function cloneTools(tools: readonly HostToolDefinitionValue[]): readonly HostToolDefinitionValue[] {
  const message = "Tool details must contain valid app data.";
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(tools);
  } catch {
    throw invalid(message);
  }
  if (serialized === undefined) throw invalid(message);
  let input: unknown;
  try {
    input = JSON.parse(serialized);
  } catch {
    throw invalid(message);
  }
  const cloned = HostToolDefinitions.safeParse(input);
  if (!cloned.success) throw invalid(message);
  return cloned.data;
}

function toWireTool(tool: HostToolDefinitionValue): OmpWire.HostToolDefinition {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function toWireScheme(scheme: HostUriDefinitionValue): OmpWire.HostUriSchemeDefinition {
  return {
    scheme: scheme.scheme,
    ...(scheme.description === undefined ? {} : { description: scheme.description }),
    writable: scheme.operations.includes("write"),
  };
}

function requireCapability(
  capabilities: CapabilityMap | undefined,
  capability: typeof I1_CAPABILITIES.hostTools | typeof I1_CAPABILITIES.hostUris,
): void {
  if (capabilities?.[capability]?.state === "available") return;
  const message =
    capability === I1_CAPABILITIES.hostTools
      ? "This omp session cannot use tools supplied by the app."
      : "This omp session cannot open addresses supplied by the app.";
  throw new AppFailure({
    code: "unavailable",
    message,
    retryable: false,
    capability,
  });
}

function invalid(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function createSerialExecutor(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation, operation);
    tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}
