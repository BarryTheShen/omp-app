import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  CapabilityMap,
  ChatSessionPort,
  McpCommandPromptListResult,
  McpCommandResourceListResult,
  McpCommandServerListResult,
  McpCommandsPort,
  type PortClient,
  ThreadId,
} from "@omp-app/contracts";
import type { SetHostToolsParams, SetHostUriSchemesParams } from "@omp-app/contracts/chat-host";
import { describe, expect, test, vi } from "vitest";
import { createHostToolPort, createHostUriPort } from "./host-registration";
import { createMcpProtocolAdapter } from "./index";

const threadId = ThreadId.parse("thread-1");

function availableCapabilities() {
  return CapabilityMap.parse({
    "omp.host-tools": { state: "available", via: "rpc" },
    "omp.host-uris": { state: "available", via: "rpc" },
  });
}

function mcpCommands(): PortClient<typeof McpCommandsPort> {
  return {
    async servers() {
      return McpCommandServerListResult.parse({ servers: [], revision: "mcp-empty" });
    },
    async prompts() {
      return McpCommandPromptListResult.parse({ prompts: [], revision: "mcp-prompts" });
    },
    async resources() {
      return McpCommandResourceListResult.parse({ resources: [], revision: "mcp-resources" });
    },
    async action() {
      throw new Error("unexpected MCP action");
    },
    async help() {
      return { lines: [] };
    },
  };
}
/** A registration request as the chat session port gets it. */
type Registration =
  | { readonly method: "set_host_tools"; readonly params: SetHostToolsParams }
  | { readonly method: "set_host_uri_schemes"; readonly params: SetHostUriSchemesParams };

function harness(capabilities = availableCapabilities()) {
  const commands: Registration[] = [];
  const registrationOwners: (string | undefined)[] = [];
  let fail: unknown;
  const request = vi.fn(
    async ({
      method,
      params,
      registrationOwner,
    }: Registration & { readonly threadId: ThreadId; readonly registrationOwner?: string }) => {
      commands.push({ method, params } as Registration);
      registrationOwners.push(registrationOwner);
      if (fail !== undefined) throw fail;
      if (method === "set_host_tools") {
        return { toolNames: (params as SetHostToolsParams).tools.map((tool) => tool.name) };
      }
      return { schemes: (params as SetHostUriSchemesParams).schemes.map(({ scheme }) => scheme) };
    },
  );
  const mcpCommandPort = mcpCommands();
  const client = {
    port(port: typeof ChatSessionPort | typeof McpCommandsPort) {
      if (port === ChatSessionPort) return { request };
      if (port === McpCommandsPort) return mcpCommandPort;
      throw new Error("unexpected port");
    },
  } as unknown as AppClient;
  return {
    client,
    commands,
    registrationOwners,
    request,
    setFailure(error: unknown) {
      fail = error;
    },
    toolPort: () => createHostToolPort({ client, threadId, capabilities }),
    uriPort: () => createHostUriPort({ client, threadId, capabilities }),
  };
}

describe("I1 AP9 host registration", () => {
  test("maps typed tool definitions to A0 and unregisters without dropping siblings", async () => {
    const host = harness();
    const tools = host.toolPort();
    const parameters = { type: "object", properties: { message: { type: "string" } } };
    const first = { name: "mcp.echo", description: "Echo text", inputSchema: parameters };
    const second = { name: "mcp.read", description: "Read files", inputSchema: { type: "object" } };

    await expect(tools.setTools([first, second])).resolves.toEqual({
      names: ["mcp.echo", "mcp.read"],
    });
    parameters.type = "changed";
    await tools.unregister("mcp.echo");

    expect(host.commands).toHaveLength(2);
    expect(host.commands[0]).toMatchObject({
      method: "set_host_tools",
      params: {
        tools: [
          {
            name: "mcp.echo",
            label: "mcp.echo",
            description: "Echo text",
            parameters: { type: "object", properties: { message: { type: "string" } } },
          },
          {
            name: "mcp.read",
            label: "mcp.read",
            description: "Read files",
            parameters: { type: "object" },
          },
        ],
      },
    });
    expect(host.commands[1]).toMatchObject({
      method: "set_host_tools",
      params: { tools: [{ name: "mcp.read", parameters: { type: "object" } }] },
    });
    await tools.unregister("mcp.echo");
    expect(host.commands).toHaveLength(2);
  });

  test("maps read/write URI permissions and rejects unrepresentable write-only schemes", async () => {
    const host = harness();
    const uris = host.uriPort();
    await expect(
      uris.setSchemes([
        { scheme: "mcp+resource", operations: ["read", "write"], description: "MCP resource" },
        { scheme: "notes", operations: ["read"] },
      ]),
    ).resolves.toEqual({ schemes: ["mcp+resource", "notes"] });
    await uris.unregister("mcp+resource");
    expect(host.commands[0]).toMatchObject({
      method: "set_host_uri_schemes",
      params: {
        schemes: [
          { scheme: "mcp+resource", description: "MCP resource", writable: true },
          { scheme: "notes", writable: false },
        ],
      },
    });
    expect(host.commands[1]).toMatchObject({
      method: "set_host_uri_schemes",
      params: { schemes: [{ scheme: "notes", writable: false }] },
    });

    const writeOnly = await uris
      .setSchemes([{ scheme: "write-only", operations: ["write"] }])
      .catch((error: unknown) => error);
    if (!(writeOnly instanceof AppFailure))
      throw new Error("Expected the unsupported operation to fail.");
    expect(writeOnly.appError).toMatchObject({
      code: "unavailable",
      capability: "upstream.mcp-uri-write-only",
    });
    expect(writeOnly.appError.message).toContain("address types that support reading");
    expect(host.commands).toHaveLength(2);
  });

  test("requires the negotiated host capability and maps unknown transport failures safely", async () => {
    const unavailableHost = harness(CapabilityMap.parse({}));
    const unavailable = await unavailableHost
      .toolPort()
      .setTools([{ name: "mcp.echo", description: "Echo text", inputSchema: {} }])
      .catch((error: unknown) => error);
    if (!(unavailable instanceof AppFailure)) throw new Error("Expected a capability failure.");
    expect(unavailable.appError).toMatchObject({
      code: "unavailable",
      capability: "omp.host-tools",
    });
    expect(unavailableHost.commands).toEqual([]);

    const host = harness();
    host.setFailure(new Error("private transport details"));
    const failure = await host
      .toolPort()
      .setTools([{ name: "mcp.echo", description: "Echo text", inputSchema: {} }])
      .catch((error: unknown) => error);
    if (!(failure instanceof AppFailure)) throw new Error("Expected a typed registration failure.");
    const hostUriUnavailable = harness(
      CapabilityMap.parse({ "omp.host-tools": { state: "available", via: "rpc" } }),
    );
    const uriFailure = await hostUriUnavailable
      .uriPort()
      .setSchemes([{ scheme: "notes", operations: ["read"] }])
      .catch((error: unknown) => error);
    if (!(uriFailure instanceof AppFailure))
      throw new Error("Expected a host URI capability failure.");
    expect(uriFailure.appError).toMatchObject({
      code: "unavailable",
      capability: "omp.host-uris",
    });
    expect(hostUriUnavailable.commands).toEqual([]);

    expect(failure.appError).toMatchObject({
      code: "internal",
      message: "Tools could not be made available to omp.",
    });
    expect(failure.appError.message).not.toContain("private transport details");
  });

  test("requires a non-blank description and gives each adapter its own owner", async () => {
    const host = harness();
    const missingDescription = await host
      .toolPort()
      .setTools([{ name: "mcp.blank", description: " ", inputSchema: {} }])
      .catch((error: unknown) => error);
    if (!(missingDescription instanceof AppFailure))
      throw new Error("Expected a description validation failure.");
    expect(missingDescription.appError.code).toBe("invalid_args");
    expect(host.commands).toEqual([]);

    await host
      .toolPort()
      .setTools([{ name: "mcp.one", description: "First tool", inputSchema: {} }]);
    await host
      .toolPort()
      .setTools([{ name: "mcp.two", description: "Second tool", inputSchema: {} }]);
    expect(new Set(host.registrationOwners).size).toBe(2);
  });
  test("rejects duplicate registrations before sending host commands", async () => {
    const host = harness();
    const tools = host.toolPort();
    const tool = { name: "mcp.echo", description: "Echo text", inputSchema: {} };
    const error = await tools.setTools([tool, tool]).catch((cause: unknown) => cause);
    if (!(error instanceof AppFailure)) throw new Error("Expected duplicate tools to be rejected.");
    expect(error.appError).toMatchObject({ code: "invalid_args" });
    expect(host.commands).toEqual([]);
  });
  test("composes catalogs and AP9 ports for one open thread", () => {
    const host = harness();
    const protocol = createMcpProtocolAdapter({
      client: host.client,
      threadId,
      capabilities: availableCapabilities(),
    });

    expect(protocol.prompts.getSnapshot().state).toBe("idle");
    expect(protocol.resources.getSnapshot().state).toBe("idle");
    expect(protocol.notifications.state).toBe("unavailable");
    expect(protocol.hostTools).toBeDefined();
    expect(protocol.hostUris).toBeDefined();
    expect(host.commands).toEqual([]);
    protocol.dispose();
  });
});
