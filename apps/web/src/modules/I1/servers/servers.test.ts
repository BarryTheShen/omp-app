import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  McpCommandActionResult,
  McpCommandPromptListResult,
  McpCommandResourceListResult,
  McpCommandServerListResult,
  McpCommandServerSummary,
  McpCommandsPort,
  type PortClient,
  ThreadId,
  validateRegistry,
} from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  createMcpServerPort,
  I1_MCP_SERVER_DESCRIPTORS,
  type McpAddServerArgs,
  type McpServerLifecyclePort,
} from ".";

const threadId = ThreadId.parse("thread-i1-mcp");

type Commands = PortClient<typeof McpCommandsPort>;

function serverSummary() {
  return McpCommandServerSummary.parse({
    name: "demo",
    scope: "project",
    transport: "stdio",
    enabled: true,
    status: "configured",
    command: "demo-server",
    auth: "unknown",
    source: { origin: "project", reloadRequired: true },
  });
}

function addSummary(args: Extract<Parameters<Commands["action"]>[0], { operation: "add" }>) {
  const transport = args.transport ?? (args.url === undefined ? "stdio" : "http");
  return McpCommandServerSummary.parse({
    name: args.name,
    scope: args.scope,
    transport,
    enabled: true,
    status: "configured",
    ...(args.url === undefined ? {} : { url: new URL(args.url).origin }),
    ...(args.command === undefined ? {} : { command: args.command.trim().split(/\s+/, 1)[0] }),
    auth: "none",
    source: { origin: args.scope, reloadRequired: true },
  });
}

function commandPort(overrides: Partial<Commands> = {}): {
  readonly calls: Parameters<Commands["action"]>[0][];
  readonly commands: Commands;
} {
  const calls: Parameters<Commands["action"]>[0][] = [];
  const defaults: Commands = {
    async servers() {
      return McpCommandServerListResult.parse({ servers: [serverSummary()], revision: "mcp-r1" });
    },
    async prompts() {
      return McpCommandPromptListResult.parse({ prompts: [], revision: "mcp-p1" });
    },
    async resources() {
      return McpCommandResourceListResult.parse({ resources: [], revision: "mcp-r1" });
    },
    async action(args) {
      calls.push(args);
      const status =
        args.operation === "test"
          ? "ready"
          : args.operation === "disable" || args.operation === "remove"
            ? "disabled"
            : "configured";
      return McpCommandActionResult.parse({
        operationId: args.operationId,
        status,
        server: args.operation === "add" ? addSummary(args) : null,
        message: "The MCP server command completed.",
      });
    },
    async help() {
      return { lines: ["MCP server commands", "  /mcp list"] };
    },
  };
  return { calls, commands: { ...defaults, ...overrides } };
}

function fakeClient(commands: Commands): AppClient {
  return {
    port(port: typeof McpCommandsPort) {
      if (port === McpCommandsPort) return commands;
      throw new Error("unexpected port");
    },
  } as unknown as AppClient;
}

function actionArgs(overrides: Partial<Parameters<McpServerLifecyclePort["remove"]>[0]> = {}) {
  return {
    name: "demo",
    scope: "project" as const,
    operationId: "op-1",
    ...overrides,
  };
}

const addArgs: McpAddServerArgs = {
  ...actionArgs({ operationId: "add-1" }),
  transport: "http",
  url: "https://mcp.example.test/api/v1",
};

describe("I1 MCP lifecycle descriptors", () => {
  test("covers each lifecycle inventory row exactly once", () => {
    const covers = I1_MCP_SERVER_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(covers).toEqual([
      "C4.mcp",
      "C4.mcp-add",
      "C4.mcp-disable",
      "C4.mcp-enable",
      "C4.mcp-help",
      "C4.mcp-list",
      "C4.mcp-reconnect",
      "C4.mcp-reload",
      "C4.mcp-remove",
      "C4.mcp-test",
    ]);
    expect(new Set(covers).size).toBe(covers.length);
  });

  test("gates server commands on the host and reconnect on upstream support", () => {
    expect(validateRegistry(I1_MCP_SERVER_DESCRIPTORS)).toEqual([]);
    expect(I1_MCP_SERVER_DESCRIPTORS[0]).toMatchObject({
      id: "I1.mcp",
      slash: { name: "mcp", source: "builtin" },
      requires: ["host.command-gateway", "host.mcp"],
    });
    expect(
      I1_MCP_SERVER_DESCRIPTORS.find((descriptor) => descriptor.id === "I1.mcpReconnect"),
    ).toMatchObject({ requires: ["host.command-gateway", "host.mcp", "upstream.mcp-reconnect"] });
  });
});

describe("I1 typed MCP command adapter", () => {
  test("uses A1's validated summaries and action methods for lifecycle operations", async () => {
    const fixture = commandPort();
    const port = createMcpServerPort(fakeClient(fixture.commands), threadId);

    expect(port.capability).toBe("host.mcp");
    expect(await port.list({ scope: "project" })).toMatchObject({
      servers: [{ name: "demo", scope: "project", command: "demo-server" }],
      revision: "mcp-r1",
    });
    await port.add(addArgs);
    await port.remove(actionArgs({ confirmed: true }));
    await port.disable(actionArgs({ confirmed: true }));
    await port.enable(actionArgs());
    await port.test(actionArgs());
    await port.reload(actionArgs());
    expect(await port.help()).toEqual(["MCP server commands", "  /mcp list"]);

    expect(fixture.calls.map((call) => call.operation)).toEqual([
      "add",
      "remove",
      "disable",
      "enable",
      "test",
      "reload",
    ]);
    expect(fixture.calls[0]).toMatchObject({
      operation: "add",
      operationId: "add-1",
      url: "https://mcp.example.test/api/v1",
      scope: "project",
    });
    expect(fixture.calls[0]?.operation === "add" ? fixture.calls[0].url : null).toBe(
      "https://mcp.example.test/api/v1",
    );
    expect(fixture.calls[1]).toMatchObject({ operation: "remove", confirmed: true });
    expect(fixture.calls[2]).toMatchObject({ operation: "disable", confirmed: true });
    expect(fixture.calls[5]).toEqual({ threadId, operation: "reload", operationId: "op-1" });
  });

  test("refuses destructive operations without confirmation before calling A1", async () => {
    const fixture = commandPort();
    const port = createMcpServerPort(fakeClient(fixture.commands), threadId);

    await expect(port.remove(actionArgs())).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    await expect(port.disable(actionArgs())).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(fixture.calls).toHaveLength(0);
  });

  test("rejects unsupported scopes before calling A1", async () => {
    const servers = vi.fn(async () =>
      McpCommandServerListResult.parse({ servers: [], revision: "mcp-r1" }),
    );
    const fixture = commandPort({ servers });
    const port = createMcpServerPort(fakeClient(fixture.commands), threadId);

    await expect(port.list({ scope: "foreign" })).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(servers).not.toHaveBeenCalled();
  });

  test("preserves typed A1 failures and maps unexpected transport failures safely", async () => {
    const typed = new AppFailure({ code: "permission", message: "denied", retryable: false });
    const typedPort = commandPort({
      async servers() {
        throw typed;
      },
    });
    const typedAdapter = createMcpServerPort(fakeClient(typedPort.commands), threadId);
    await expect(typedAdapter.list()).rejects.toBe(typed);

    const failed = commandPort({
      async servers() {
        throw new Error("private path and secret-token");
      },
    });
    const failedAdapter = createMcpServerPort(fakeClient(failed.commands), threadId);
    await expect(failedAdapter.list()).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message: "MCP server details are unavailable.",
        capability: "host.mcp",
        retryable: false,
      },
    });
  });

  test("keeps the visible reconnect reason tied to upstream support", async () => {
    const fixture = commandPort();
    const port = createMcpServerPort(fakeClient(fixture.commands), threadId);

    await expect(port.reconnect(actionArgs())).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        capability: "upstream.mcp-reconnect",
        message: "Reconnect this MCP server in the omp terminal; this app cannot reconnect it.",
      },
    });
    expect(fixture.calls).toHaveLength(0);
  });
});
