import type { AppClient } from "@omp-app/client";
import {
  type AbortSignalLike,
  AppFailure,
  McpCommandActionResult,
  McpCommandPromptListResult,
  McpCommandResourceListResult,
  McpCommandServerListResult,
  McpCommandServerSummary,
  McpCommandsPort,
  type PortCallOptions,
  type PortClient,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createMcpProtocolCatalogs } from "./catalog";

const threadId = ThreadId.parse("thread-1");
type Commands = PortClient<typeof McpCommandsPort>;

function serverList(
  enabled = true,
  revision = "mcp-servers-r1",
  truncated = false,
  skippedCount = 0,
) {
  const server = McpCommandServerSummary.parse({
    name: "demo",
    scope: "user",
    transport: "stdio",
    enabled,
    status: enabled ? "configured" : "disabled",
    command: "demo-server",
    auth: "unknown",
    source: { origin: "user", reloadRequired: true },
  });
  return McpCommandServerListResult.parse({ servers: [server], revision, truncated, skippedCount });
}

function harness(initial: Partial<Commands> = {}) {
  const calls: string[] = [];
  const defaults: Commands = {
    async servers() {
      return serverList();
    },
    async prompts() {
      return McpCommandPromptListResult.parse({
        prompts: [
          {
            id: "mcp-prompt-0000000000000001",
            server: "demo",
            name: "welcome",
            description: "A friendly greeting",
          },
        ],
        revision: "mcp-prompts-r1",
      });
    },
    async resources() {
      return McpCommandResourceListResult.parse({
        resources: [
          {
            id: "mcp-resource-0000000000000001",
            server: "demo",
            uri: "https://example.test/resources/readme",
            name: "readme",
          },
        ],
        revision: "mcp-resources-r1",
      });
    },
    async action(args) {
      return McpCommandActionResult.parse({
        operationId: args.operationId,
        status: "configured",
        server: null,
      });
    },
    async help() {
      return { lines: ["MCP server commands"] };
    },
  };
  let responders: Commands = { ...defaults, ...initial };
  const commands: Commands = {
    async servers(args, options?: PortCallOptions) {
      calls.push("servers");
      return responders.servers(args, options);
    },
    async prompts(args, options?: PortCallOptions) {
      calls.push("prompts");
      return responders.prompts(args, options);
    },
    async resources(args, options?: PortCallOptions) {
      calls.push("resources");
      return responders.resources(args, options);
    },
    async action(args, options?: PortCallOptions) {
      calls.push("action");
      return responders.action(args, options);
    },
    async help(args, options?: PortCallOptions) {
      calls.push("help");
      return responders.help(args, options);
    },
  };
  const client = {
    port(port: typeof McpCommandsPort) {
      if (port === McpCommandsPort) return commands;
      throw new Error("unexpected port");
    },
  } as unknown as AppClient;
  return {
    client,
    calls,
    setResponders(next: Partial<Commands>) {
      responders = { ...responders, ...next };
    },
  };
}

describe("I1 MCP protocol catalogs", () => {
  test("uses typed A1 prompt/resource summaries and reuses ready snapshots", async () => {
    const client = harness();
    const catalogs = createMcpProtocolCatalogs({ client: client.client, threadId });

    const prompts = await catalogs.prompts.list();
    const resources = await catalogs.resources.list();

    expect(prompts).toEqual([
      expect.objectContaining({
        id: "mcp-prompt-0000000000000001",
        server: "demo",
        name: "welcome",
        description: "A friendly greeting",
      }),
    ]);
    expect(catalogs.prompts.getSnapshot()).toMatchObject({
      state: "ready",
      serverRevision: "mcp-servers-r1",
    });
    expect(resources).toEqual([
      expect.objectContaining({
        id: "mcp-resource-0000000000000001",
        server: "demo",
        name: "readme",
        uri: "https://example.test/resources/readme",
      }),
    ]);
    expect(catalogs.resources.getSnapshot()).toMatchObject({
      state: "ready",
      serverRevision: "mcp-servers-r1",
    });
    await expect(catalogs.prompts.list()).resolves.toEqual(prompts);
    expect(client.calls).toEqual(["servers", "prompts", "servers", "resources", "servers"]);

    catalogs.dispose();
  });
  test("refreshes a ready prompt catalog after the server list revision changes", async () => {
    const client = harness();
    const catalogs = createMcpProtocolCatalogs({ client: client.client, threadId });
    await catalogs.prompts.list();
    client.setResponders({
      async servers() {
        return serverList(true, "mcp-servers-r2");
      },
      async prompts() {
        return McpCommandPromptListResult.parse({
          prompts: [{ id: "mcp-prompt-0000000000000002", server: "demo", name: "updated" }],
          revision: "mcp-prompts-r2",
        });
      },
    });

    await expect(catalogs.prompts.list()).resolves.toMatchObject([{ name: "updated" }]);
    expect(catalogs.prompts.getSnapshot()).toMatchObject({
      state: "ready",
      serverRevision: "mcp-servers-r2",
    });
    expect(client.calls).toEqual(["servers", "prompts", "servers", "prompts"]);
    catalogs.dispose();
  });
  test("exposes skipped and truncated MCP catalog counts", async () => {
    const client = harness({
      async servers() {
        return serverList(true, "mcp-servers-truncated", true, 2);
      },
      async prompts() {
        return McpCommandPromptListResult.parse({
          prompts: [],
          revision: "mcp-prompts-truncated",
          truncated: true,
          skippedCount: 3,
        });
      },
    });
    const catalogs = createMcpProtocolCatalogs({ client: client.client, threadId });

    await expect(catalogs.prompts.list()).resolves.toEqual([]);
    expect(catalogs.prompts.getSnapshot()).toMatchObject({
      state: "ready",
      truncated: true,
      skippedCount: 5,
    });
    catalogs.dispose();
  });

  test("preserves typed errors and keeps the last ready catalog stale across refresh failures", async () => {
    const client = harness();
    const catalogs = createMcpProtocolCatalogs({ client: client.client, threadId });
    const initial = await catalogs.prompts.list();
    const firstRevision = catalogs.prompts.getSnapshot().revision;
    const failure = new AppFailure({
      code: "omp_error",
      message: "The MCP prompt list could not be refreshed.",
      retryable: true,
    });
    client.setResponders({
      async prompts() {
        throw failure;
      },
    });

    await expect(catalogs.prompts.list()).resolves.toEqual(initial);
    await expect(catalogs.prompts.refresh()).rejects.toBe(failure);
    expect(catalogs.prompts.getSnapshot()).toMatchObject({
      state: "stale",
      entries: initial,
      revision: firstRevision,
      error: failure.appError,
    });

    client.setResponders({
      async prompts() {
        return McpCommandPromptListResult.parse({
          prompts: [{ id: "mcp-prompt-0000000000000002", server: "demo", name: "farewell" }],
          revision: "mcp-prompts-r2",
        });
      },
    });
    await expect(catalogs.prompts.refresh()).resolves.toMatchObject([
      { server: "demo", name: "farewell" },
    ]);
    expect(catalogs.prompts.getSnapshot().state).toBe("ready");
    expect(catalogs.prompts.getSnapshot().revision).not.toBe(firstRevision);
    catalogs.dispose();
  });

  test("keeps an empty catalog stale after a failed refresh", async () => {
    const client = harness({
      async prompts() {
        return McpCommandPromptListResult.parse({ prompts: [], revision: "mcp-prompts-empty" });
      },
    });
    const catalogs = createMcpProtocolCatalogs({ client: client.client, threadId });
    await expect(catalogs.prompts.list()).resolves.toEqual([]);

    const failure = new AppFailure({
      code: "omp_error",
      message: "The list is unavailable.",
      retryable: true,
    });
    client.setResponders({
      async prompts() {
        throw failure;
      },
    });
    await expect(catalogs.prompts.refresh()).rejects.toBe(failure);
    expect(catalogs.prompts.getSnapshot()).toMatchObject({
      state: "stale",
      entries: [],
      error: failure.appError,
    });
    catalogs.dispose();
  });

  test("a cancelled waiter does not abort a shared catalog read", async () => {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const requestSignals: (AbortSignalLike | undefined)[] = [];
    const client = harness({
      async prompts(_args, options) {
        requestSignals.push(options?.signal);
        started.resolve();
        await gate.promise;
        return McpCommandPromptListResult.parse({
          prompts: [{ id: "mcp-prompt-0000000000000003", server: "demo", name: "shared" }],
          revision: "mcp-prompts-shared",
        });
      },
    });
    const catalogs = createMcpProtocolCatalogs({ client: client.client, threadId });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = catalogs.prompts.refresh({ signal: firstController.signal });
    const second = catalogs.prompts.refresh({ signal: secondController.signal });

    await started.promise;
    firstController.abort();
    await expect(first).rejects.toMatchObject({ appError: { code: "cancelled" } });
    gate.resolve();
    await expect(second).resolves.toMatchObject([{ name: "shared" }]);
    expect(requestSignals).toEqual([undefined]);
    catalogs.dispose();
  });

  test("returns an empty ready catalog without querying it when no server is enabled", async () => {
    const client = harness({
      async servers() {
        return serverList(false);
      },
      async prompts() {
        throw new Error("the prompt catalog should not be queried");
      },
    });
    const catalogs = createMcpProtocolCatalogs({ client: client.client, threadId });

    await expect(catalogs.prompts.list()).resolves.toEqual([]);
    expect(catalogs.prompts.getSnapshot()).toMatchObject({ state: "ready", entries: [] });
    expect(client.calls).toEqual(["servers"]);
    catalogs.dispose();
  });

  test("reports prompt expansion and live notifications as upstream-only capabilities", async () => {
    const client = harness();
    const catalogs = createMcpProtocolCatalogs({ client: client.client, threadId });
    const unavailable = await catalogs.prompts
      .invoke({ id: "prompt-id", arguments: { topic: "hello" } })
      .catch((error: unknown) => error);

    if (!(unavailable instanceof AppFailure)) throw new Error("Expected an unavailable failure.");
    expect(unavailable.appError).toMatchObject({
      code: "unavailable",
      capability: "upstream.mcp-prompt-expansion",
    });
    expect(unavailable.appError.message).toContain("can only list prompts");
    expect(catalogs.notifications).toMatchObject({
      state: "unavailable",
      capability: "upstream.mcp-notifications",
    });
    expect(catalogs.notifications.reason).toContain("omp terminal");
    expect(client.calls).toEqual([]);
    catalogs.dispose();
  });
});
