import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CommandRunResult,
  OmpCommandGateway,
  type PortClient,
  type SlashCommand,
  ThreadId,
  validateRegistry,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  createMcpServerPort,
  I1_MCP_SERVER_DESCRIPTORS,
  type McpAddServerArgs,
  type McpServerLifecyclePort,
  parseMcpServerActionOutput,
  parseMcpServerListOutput,
} from ".";

const threadId = ThreadId.parse("thread-i1-mcp");
const listOutput = [
  "filesystem | stdio | enabled | npx [project]",
  "remote | http | disabled | https://mcp.example.test/api [user]",
].join("\n");

function commandResult(
  command: SlashCommand,
  output: string,
  status: CommandRunResult["status"] = "completed",
): CommandRunResult {
  return {
    command,
    status,
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: output === "" ? [] : [{ text: output }],
    sessionUpdates: [],
    configUpdates: [],
  };
}

function fakeClient(run: PortClient<typeof OmpCommandGateway>["run"]): AppClient {
  return {
    port(port: typeof OmpCommandGateway) {
      if (port === OmpCommandGateway) return { run };
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
  url: "https://mcp.example.test",
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

  test("claims only I1's /mcp namespace and gates the typed gateway", () => {
    expect(validateRegistry(I1_MCP_SERVER_DESCRIPTORS)).toEqual([]);
    expect(I1_MCP_SERVER_DESCRIPTORS[0]).toMatchObject({
      id: "I1.mcp",
      slash: { name: "mcp", source: "builtin" },
      requires: ["host.command-gateway", "host.mcp"],
    });
  });
});

describe("I1 MCP output parsers", () => {
  test("parses the exact v18.6.1 list rows into redacted summaries", () => {
    const result = parseMcpServerListOutput(listOutput);
    expect(result.servers).toEqual([
      {
        name: "filesystem",
        scope: "project",
        transport: "stdio",
        enabled: true,
        status: "configured",
        command: "npx",
        auth: "unknown",
        source: { origin: "project", reloadRequired: true },
      },
      {
        name: "remote",
        scope: "user",
        transport: "http",
        enabled: false,
        status: "disabled",
        url: "https://mcp.example.test",
        auth: "unknown",
        source: { origin: "user", reloadRequired: true },
      },
    ]);
  });

  test("recognizes the exact empty-list output", () => {
    const result = parseMcpServerListOutput("No MCP servers configured.");
    expect(result.servers).toEqual([]);
  });

  test("does not guess malformed output and redacts raw failure text", () => {
    expect(() =>
      parseMcpServerListOutput("not a server row https://mcp.example.test/?token=secret-value"),
    ).toThrowError(/couldn't read this output safely/);
    try {
      parseMcpServerListOutput("not a server row https://mcp.example.test/?token=secret-value");
    } catch (error) {
      expect(error).toMatchObject({
        appError: {
          code: "internal",
          message: expect.stringContaining("Raw output:"),
        },
      });
      expect((error as AppFailure).appError.message).not.toContain("secret-value");
      expect((error as AppFailure).appError.message).toContain("<redacted>");
    }
  });

  test("preserves omp's real failure reason and capability-gated reconnect state", () => {
    expect(() =>
      parseMcpServerActionOutput(
        "test",
        actionArgs(),
        'Connection to "demo" failed: ECONNREFUSED 127.0.0.1:7331',
      ),
    ).toThrowError(/ECONNREFUSED/);
    try {
      parseMcpServerActionOutput(
        "reconnect",
        actionArgs(),
        "/mcp reconnect requires OAuth or browser flows only available in the TUI client.",
      );
    } catch (error) {
      expect(error).toMatchObject({ appError: { code: "unavailable" } });
      expect((error as AppFailure).appError.message).toContain("OAuth or browser flows");
    }
  });

  test("parses add, toggle, test, reconnect and reload confirmations exactly", () => {
    expect(
      parseMcpServerActionOutput("add", addArgs, 'Added MCP server "demo" (project).', addArgs),
    ).toMatchObject({
      operationId: "add-1",
      status: "configured",
      server: { name: "demo", transport: "http", url: "https://mcp.example.test" },
    });
    expect(
      parseMcpServerActionOutput("enable", actionArgs(), 'Server "demo" enabled (project config).'),
    ).toMatchObject({ status: "configured" });
    expect(
      parseMcpServerActionOutput(
        "disable",
        actionArgs({ confirmed: true }),
        'Server "demo" disabled (project config).',
      ),
    ).toMatchObject({ status: "disabled" });
    expect(
      parseMcpServerActionOutput(
        "test",
        actionArgs(),
        'Server "demo" connected (2 tools).\n  - read\n  - write',
      ),
    ).toMatchObject({ status: "ready" });
    expect(
      parseMcpServerActionOutput("reconnect", actionArgs(), 'Reconnected to "demo"\n  Tools: 2'),
    ).toMatchObject({ status: "ready" });
    expect(
      parseMcpServerActionOutput(
        "reload",
        actionArgs({ name: "reload" }),
        "MCP runtime reload requested.",
      ),
    ).toMatchObject({ status: "configured" });
  });
});

describe("I1 MCP typed command gateway adapter", () => {
  test("sends every lifecycle operation through A1.8 with v18.6.1 grammar", async () => {
    const commands: string[] = [];
    const outputByCommand: Record<string, string> = {
      "/mcp list": listOutput,
      "/mcp add demo --scope project --url https://mcp.example.test --transport http":
        'Added MCP server "demo" (project).',
      "/mcp remove demo --scope project": 'Removed server "demo" from project config.',
      "/mcp disable demo": 'Server "demo" disabled (project config).',
      "/mcp test demo": 'Server "demo" connected (0 tools).',
      "/mcp reconnect demo": 'Reconnected to "demo"\n  Tools: 0',
      "/mcp reload": "MCP runtime reload requested.",
      "/mcp help": "MCP server management (ACP mode)\n  /mcp list",
    };
    const client = fakeClient(async ({ threadId: calledThread, command }) => {
      expect(calledThread).toBe(threadId);
      commands.push(command);
      return commandResult(command, outputByCommand[command] ?? "");
    });
    const port = createMcpServerPort(client, threadId);

    await port.list();
    await port.add(addArgs);
    await port.remove(actionArgs({ confirmed: true }));
    await port.toggle(
      { ...actionArgs({ confirmed: true }), enabled: false },
      { signal: undefined },
    );
    await port.test(actionArgs());
    await port.reconnect(actionArgs());
    await port.reload(actionArgs({ name: "reload" }));
    expect(await port.help()).toEqual(["MCP server management (ACP mode)", "  /mcp list"]);
    expect(commands).toEqual([
      "/mcp list",
      "/mcp add demo --scope project --url https://mcp.example.test --transport http",
      "/mcp remove demo --scope project",
      "/mcp disable demo",
      "/mcp test demo",
      "/mcp reconnect demo",
      "/mcp reload",
      "/mcp help",
    ]);
  });

  test("requires confirmation for destructive operations before gateway admission", async () => {
    let calls = 0;
    const port = createMcpServerPort(
      fakeClient(async () => {
        calls += 1;
        return commandResult("/mcp remove demo" as SlashCommand, "");
      }),
      threadId,
    );
    await expect(port.remove(actionArgs())).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    await expect(port.disable(actionArgs())).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(calls).toBe(0);
  });

  test("preserves typed gateway failures and maps unknown transport failures safely", async () => {
    const typed = new AppFailure({ code: "permission", message: "denied", retryable: false });
    const typedPort = createMcpServerPort(
      fakeClient(async () => {
        throw typed;
      }),
      threadId,
    );
    await expect(typedPort.list()).rejects.toBe(typed);

    const failedPort = createMcpServerPort(
      fakeClient(async () => {
        throw new Error("private path and secret-token");
      }),
      threadId,
    );
    await expect(failedPort.list()).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message: "MCP list command gateway is unavailable.",
        capability: "host.mcp",
      },
    });
  });

  test("surfaces an aborted typed gateway result as cancellation", async () => {
    const port = createMcpServerPort(
      fakeClient(async ({ command }) => commandResult(command, "", "aborted")),
      threadId,
    );
    await expect(port.list()).rejects.toMatchObject({ appError: { code: "cancelled" } });
  });
});
