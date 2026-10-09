import { describe, expect, test } from "bun:test";
import {
  AppFailure,
  type CommandRunArgs,
  CommandRunResult,
  type CommandRunResult as CommandRunResultValue,
  McpCommandActionArgs,
  ThreadId,
} from "@omp-app/contracts";
import { type McpCommandRunner, McpCommandsService } from "./service";

const threadId = ThreadId.parse("session-1");

function resultFor(command: CommandRunArgs["command"], text: string): CommandRunResultValue {
  return CommandRunResult.parse({
    command,
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: text.length === 0 ? [] : [{ text }],
    sessionUpdates: [],
    configUpdates: [],
  });
}

function serviceFor(text: string): {
  readonly calls: CommandRunArgs[];
  readonly service: McpCommandsService;
} {
  const calls: CommandRunArgs[] = [];
  const runner: McpCommandRunner = {
    async run(args) {
      calls.push(args);
      return resultFor(args.command, text);
    },
  };
  return { calls, service: new McpCommandsService(runner) };
}

function mcpAction(args: Record<string, unknown>) {
  return McpCommandActionArgs.parse({ threadId, ...args });
}

async function appFailure(promise: Promise<unknown>): Promise<AppFailure> {
  const result = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(result instanceof AppFailure)) throw new Error("expected an AppFailure");
  return result;
}
/** Mirrors the non-strict tokenizer in omp v18.6.1 `utils/command-args.ts`. */
function parseOmpCommandArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (inQuote !== null) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/** Wall-clock milliseconds for one `prompts` call whose only description is `text`. */
async function promptsMs(text: string): Promise<number> {
  const { service } = serviceFor(`atlas/explain — ${text}`);
  const started = performance.now();
  const result = await service.prompts({ threadId });
  const elapsed = performance.now() - started;
  expect(result.prompts[0]?.description?.length).toBeLessThanOrEqual(2_048);
  return elapsed;
}

// A quadratic pattern takes about 16 times as long on four times the input; a linear one about 4.
// The limit is a ratio, not a wall-clock bound, so a busy machine slows both runs alike.
const LINEAR_GROWTH_LIMIT = 12;
// A run under two milliseconds is mostly noise, so the small run is never counted as less.
const TIMING_FLOOR_MS = 2;

/** Large-input time over small-input time, with the small time floored. */
async function growthRatio(build: (length: number) => string, small: number): Promise<number> {
  // Untimed warm-up: a regex's first run is far slower, and a slow small run hides growth.
  await promptsMs(build(small));
  const smallMs = await promptsMs(build(small));
  const largeMs = await promptsMs(build(4 * small));
  return largeMs / Math.max(smallMs, TIMING_FLOOR_MS);
}

describe("McpCommandsService", () => {
  test("parses v18.6.1 list output and exposes only remote URL origins", async () => {
    const { service } = serviceFor(
      [
        "local | stdio | enabled | bun [user]",
        "remote | http | disabled | https://mcp.example.test/api/v1?token=secret [project]",
      ].join("\n"),
    );

    const result = await service.servers({ threadId });

    expect(result.servers).toEqual([
      {
        name: "local",
        scope: "user",
        transport: "stdio",
        enabled: true,
        status: "configured",
        command: "bun",
        auth: "unknown",
        source: { origin: "user", reloadRequired: true },
      },
      {
        name: "remote",
        scope: "project",
        transport: "http",
        enabled: false,
        status: "disabled",
        url: "https://mcp.example.test",
        auth: "unknown",
        source: { origin: "project", reloadRequired: true },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  test("accepts omp server names, skips a name with spaces, and shows only local executable names", async () => {
    const { service } = serviceFor(
      [
        "cloudflare:cloudflare-api | stdio | enabled | bun [user]",
        "MaaS Slack | stdio | enabled | /usr/local/my tools/server [user]",
        "_internal | stdio | disabled | /opt/private/mcp-server [project]",
      ].join("\n"),
    );
    const result = await service.servers({ threadId });

    expect(result.servers.map((server) => server.name)).toEqual([
      "cloudflare:cloudflare-api",
      "_internal",
    ]);
    expect(result.servers.map((server) => server.command)).toEqual(["bun", "mcp-server"]);
    // A name with a space is counted as skipped: omp cannot address that server again.
    expect(result.skippedCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("/opt/private");
    expect(JSON.stringify(result)).not.toContain("/usr/local");
  });

  test("parses v18.6.1 prompt and resource formatter fixtures", async () => {
    const prompt = serviceFor("atlas/explain — Explains a codebase.");
    const promptResult = await prompt.service.prompts({ threadId });
    expect(promptResult.prompts).toEqual([
      expect.objectContaining({
        server: "atlas",
        name: "explain",
        description: "Explains a codebase.",
      }),
    ]);

    const resource = serviceFor("atlas/file:///workspace/docs/guide.md");
    const resourceResult = await resource.service.resources({ threadId });
    expect(resourceResult.resources).toEqual([
      expect.objectContaining({
        server: "atlas",
        uri: "file:///workspace/docs/guide.md",
        name: "guide.md",
      }),
    ]);
  });
  test("keeps a description line with a slash in the description, not as a new prompt", async () => {
    const prompt = serviceFor(
      ["atlas/explain — Explains a codebase.", "Example: src/index.ts is the entry."].join("\n"),
    );
    const result = await prompt.service.prompts({ threadId });

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.description).toBe(
      "Explains a codebase.\nExample: src/index.ts is the entry.",
    );
  });
  test("redacts URL credentials and sanitizes hostile long runs in linear time", async () => {
    const credentialed = serviceFor("atlas/explain — fetch https://user:hunter2@example.test/x");
    const redacted = await credentialed.service.prompts({ threadId });
    expect(redacted.prompts[0]?.description).toContain("https://<redacted>@example.test/x");
    expect(redacted.prompts[0]?.description).not.toContain("hunter2");

    // omp sends a whole prompt list as one frame, so a hostile description can be about 40,000 characters.
    // Letters and paths are measured from 10,000 to 40,000 characters. The private-key pattern
    // rescans to the end of the text for each unclosed header, so it grows faster than linear
    // (10 to 12 times from 10,000 to 40,000 characters); it is measured from 5,000 to 20,000.
    const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const hostileRuns: Array<[string, number, (length: number) => string]> = [
      ["a long run of letters", 10_000, (length) => "a".repeat(length)],
      [
        "repeated private key headers",
        5_000,
        (length) =>
          privateKeyHeader.repeat(Math.ceil(length / privateKeyHeader.length)).slice(0, length),
      ],
      ["a long absolute path", 10_000, (length) => `/home${"/a".repeat(length / 2)}`],
    ];
    const overLimit: Array<[string, number]> = [];
    for (const [name, small, build] of hostileRuns) {
      let ratio = await growthRatio(build, small);
      // One retry, so a single scheduling pause during one measurement cannot fail the test.
      if (ratio >= LINEAR_GROWTH_LIMIT) ratio = await growthRatio(build, small);
      if (ratio >= LINEAR_GROWTH_LIMIT) overLimit.push([name, ratio]);
    }
    expect(overLimit).toEqual([]);
  }, 30_000);
  test("keeps multiline descriptions and bounds long catalog entries and lists", async () => {
    const longName = "n".repeat(300);
    const longDescription = "d".repeat(2_050);
    const promptOutput = [
      "atlas/docstring — First line of a docstring.",
      "",
      "Args:",
      "    topic: what to explain",
      `atlas/${longName} — ${longDescription}`,
    ].join("\n");
    const prompts = await serviceFor(promptOutput).service.prompts({ threadId });
    expect(prompts.prompts[0]?.description).toBe(
      "First line of a docstring.\n\nArgs:\n    topic: what to explain",
    );
    expect(prompts.prompts[1]?.name).toBe(`${"n".repeat(255)}…`);
    expect(prompts.prompts[1]?.description).toHaveLength(2_048);
    expect(prompts.truncated).toBe(true);
    expect(prompts.skippedCount).toBe(0);

    const oversizedUri = `https://example.test/${"segment".repeat(350)}`;
    const longResource = await serviceFor(`atlas/${oversizedUri}`).service.resources({ threadId });
    expect(longResource.resources[0]?.uri).toHaveLength(2_048);
    expect(longResource.truncated).toBe(true);

    const manyResources = Array.from(
      { length: 300 },
      (_, index) => `atlas/file:///workspace/${index}/readme.md`,
    ).join("\n");
    const resourceCatalog = await serviceFor(manyResources).service.resources({ threadId });
    expect(resourceCatalog.resources).toHaveLength(256);
    expect(resourceCatalog.truncated).toBe(true);
    expect(resourceCatalog.skippedCount).toBe(44);
    const manyServers = Array.from(
      { length: 300 },
      (_, index) => `server-${index} | stdio | enabled | bun [user]`,
    ).join("\n");
    const serverCatalog = await serviceFor(manyServers).service.servers({ threadId });
    expect(serverCatalog.servers).toHaveLength(256);
    expect(serverCatalog.truncated).toBe(true);
    expect(serverCatalog.skippedCount).toBe(44);

    const manyPrompts = Array.from({ length: 300 }, (_, index) => `atlas/prompt-${index}`).join(
      "\n",
    );
    const promptCatalog = await serviceFor(manyPrompts).service.prompts({ threadId });
    expect(promptCatalog.prompts).toHaveLength(256);
    expect(promptCatalog.truncated).toBe(true);
    expect(promptCatalog.skippedCount).toBe(44);
  });

  test("redacts MCP prompt and resource output and rejects malformed rows safely", async () => {
    const password = "p".repeat(16);
    const accessToken = ["Bearer", "t".repeat(32)].join(" ");
    const promptOutput = `atlas/explain — See https://user:${password}@mcp.example.test/?access_token=${encodeURIComponent(accessToken)}`;
    const prompts = await serviceFor(promptOutput).service.prompts({ threadId });
    const promptJson = JSON.stringify(prompts);
    expect(prompts.prompts[0]?.description).toContain("<redacted>");
    expect(promptJson).not.toContain(password);
    expect(promptJson).not.toContain("t".repeat(32));

    const headerValues = ["header-token-value", "session-cookie-value"];
    const headerOutput = [
      "atlas/headers — Authorization: Bearer header-token-value",
      "Cookie: session=session-cookie-value",
      '{"headers":{"Authorization":"Token header-token-value","Cookie":"session-cookie-value"}}',
    ].join("\n");
    const headerCatalog = await serviceFor(headerOutput).service.prompts({ threadId });
    const headerJson = JSON.stringify(headerCatalog);
    for (const value of headerValues) expect(headerJson).not.toContain(value);

    const queryValues = [
      "auth-value",
      "sig-value",
      "key-value",
      "signature-value",
      "code-value",
      "session-value",
    ];
    const queryPrompt = [
      "atlas/links — ",
      "?auth=auth-value&sig=sig-value&key=key-value&X-Amz-Signature=signature-value",
      "?code=code-value&sessionid=session-value",
    ].join("\n");
    const queryCatalog = await serviceFor(queryPrompt).service.prompts({ threadId });
    const queryJson = JSON.stringify(queryCatalog);
    for (const value of queryValues) expect(queryJson).not.toContain(value);

    const resourceOutput = `atlas/https://user:${password}@mcp.example.test/data?access_token=${encodeURIComponent(accessToken)}`;
    const resources = await serviceFor(resourceOutput).service.resources({ threadId });
    const resourceJson = JSON.stringify(resources);
    expect(resources.resources[0]?.uri).toContain("<redacted>");
    expect(resourceJson).not.toContain(password);
    expect(resourceJson).not.toContain("t".repeat(32));

    const apiKey = ["sk", "ant", "k".repeat(30)].join("-");
    const keyedPrompt = await serviceFor(
      `atlas/explain — Credentials {"api_key":"${apiKey}"}`,
    ).service.prompts({ threadId });
    expect(JSON.stringify(keyedPrompt)).not.toContain(apiKey);

    const privateResources = await serviceFor(
      ["atlas/file:///var/home/private/docs/a.md", "atlas/file:///var/home/private/docs/b.md"].join(
        "\n",
      ),
    ).service.resources({ threadId });
    expect(privateResources.resources.map((resource) => resource.uri)).toEqual([
      "file://<private-path>/a.md",
      "file://<private-path>/b.md",
    ]);
    expect(privateResources.resources[0]?.id).not.toBe(privateResources.resources[1]?.id);
    expect(JSON.stringify(privateResources)).not.toContain("/var/home");

    const windowsResource = await serviceFor(
      "atlas/file:///C:/private/docs/guide.md",
    ).service.resources({ threadId });
    expect(windowsResource.resources[0]?.uri).toContain("<private-path>");
    expect(JSON.stringify(windowsResource)).not.toContain("C:/private");

    const rawOutput = `untrusted MCP response ${accessToken}`;
    const safeCatalog = await serviceFor(rawOutput).service.prompts({ threadId });
    expect(safeCatalog).toMatchObject({ prompts: [], truncated: true, skippedCount: 1 });
    expect(JSON.stringify(safeCatalog)).not.toContain(rawOutput);
    expect(JSON.stringify(safeCatalog)).not.toContain("t".repeat(32));
  });

  test("normalizes the v18.6.1 empty prompt and resource messages", async () => {
    const prompts = await serviceFor("No prompts available on connected servers.").service.prompts({
      threadId,
    });
    const resources = await serviceFor(
      "No resources available on connected servers.",
    ).service.resources({ threadId });
    expect(prompts.prompts).toEqual([]);
    expect(resources.resources).toEqual([]);
  });

  test("treats successful action output with failure-like names as success", async () => {
    const add = serviceFor('Added MCP server "failed-jobs" (user).');
    const added = await add.service.action(
      mcpAction({
        operation: "add",
        operationId: "add-1",
        name: "failed-jobs",
        scope: "user",
        transport: "http",
        url: "https://mcp.example.test/api/v1",
      }),
    );
    expect(added.status).toBe("configured");
    expect(added.server?.url).toBe("https://mcp.example.test");
    expect(added.message).toBe("The MCP server was added.");
    expect(add.calls[0]?.command).toContain("https://mcp.example.test/api/v1");

    const testServer = serviceFor(
      'Server "build_failure_logs" connected (2 tools).\n  - get_build_failure_logs',
    );
    const tested = await testServer.service.action(
      mcpAction({
        operation: "test",
        operationId: "test-1",
        name: "build_failure_logs",
        scope: "user",
      }),
    );
    expect(tested.status).toBe("ready");
    expect(tested.message).toBe("Connected to the MCP server. Found 2 tools.");
  });
  test("uses singular wording when one MCP tool connects", async () => {
    const tested = await serviceFor('Server "one" connected (1 tools).').service.action(
      mcpAction({
        operation: "test",
        operationId: "test-one",
        name: "one",
        scope: "user",
      }),
    );
    expect(tested.message).toBe("Connected to the MCP server. Found 1 tool.");
  });
  test("quotes MCP add words so omp's parser preserves every argument", async () => {
    const serverName = "maas-slack";
    const expectedArguments = [
      "local tools/server",
      "--root",
      "My Documents",
      "--flag",
      "it's",
      "$value",
      "`tick`",
      'say "hi"',
      "Program Files\\server",
    ];
    const add = serviceFor(`Added MCP server "${serverName}" (user).`);
    const result = await add.service.action(
      mcpAction({
        operation: "add",
        operationId: "add-quoted",
        name: serverName,
        scope: "user",
        command: expectedArguments[0],
        args: expectedArguments.slice(1),
      }),
    );

    expect(result.server?.command).toBe("server");
    expect(parseOmpCommandArgs(add.calls[0]?.command ?? "")).toEqual([
      "/mcp",
      "add",
      serverName,
      "--scope",
      "user",
      "--",
      ...expectedArguments,
    ]);
  });
  test("refuses a server name with spaces before any command runs", async () => {
    for (const operation of ["add", "remove", "enable", "disable", "test"] as const) {
      const spaced = serviceFor("Done.");
      // The port parses the contract first, so this object skips that parse to check the service's own guard.
      const action = {
        threadId,
        operation,
        operationId: `spaced-${operation}`,
        name: "MaaS Slack",
        scope: "user",
        ...(operation === "add" ? { command: "server" } : {}),
      } as unknown as McpCommandActionArgs;
      const error = await appFailure(spaced.service.action(action));
      expect(error.appError.code).toBe("invalid_args");
      expect(spaced.calls).toHaveLength(0);
    }
  });
  test("classifies list and duplicate-add failures and hides raw gateway errors", async () => {
    const privateConfigPath = `/${["home", "me", ".omp", "agent", "mcp.json"].join("/")}`;
    const rawListError = "Failed to list MCP servers: JSON Parse error: Expected '}'";
    const listError = await appFailure(serviceFor(rawListError).service.servers({ threadId }));
    expect(listError.appError).toMatchObject({
      code: "omp_error",
      message: "The MCP server command could not be completed.",
    });
    expect(JSON.stringify(listError.appError)).not.toContain(rawListError);

    const duplicate = await appFailure(
      serviceFor(
        `Failed to add server: Server "alpha" already exists in ${privateConfigPath}`,
      ).service.action(
        mcpAction({
          operation: "add",
          operationId: "add-duplicate",
          name: "alpha",
          scope: "user",
          command: "bun",
        }),
      ),
    );
    expect(duplicate.appError).toMatchObject({ code: "conflict", retryable: false });
    expect(duplicate.appError.message).toContain("already exists");
    expect(JSON.stringify(duplicate.appError)).not.toContain(privateConfigPath);

    const rawPathError = new AppFailure({
      code: "omp_error",
      message: `EACCES opening ${privateConfigPath}`,
      retryable: false,
      omp: { error: `EACCES opening ${privateConfigPath}` },
    });
    const runner: McpCommandRunner = {
      async run() {
        throw rawPathError;
      },
    };
    const gatewayError = await appFailure(new McpCommandsService(runner).prompts({ threadId }));
    expect(gatewayError.appError).toMatchObject({
      code: "omp_error",
      message: "The MCP prompt list command could not be completed.",
    });
    expect(JSON.stringify(gatewayError.appError)).not.toContain(privateConfigPath);
  });

  test("classifies omp's missing-server test response as not found", async () => {
    const { service } = serviceFor(
      'Server "missing" not found. Run /mcp list to see configured servers.',
    );
    const error = await appFailure(
      service.action(
        mcpAction({
          operation: "test",
          operationId: "test-missing",
          name: "missing",
          scope: "user",
        }),
      ),
    );
    expect(error.appError).toMatchObject({ code: "not_found", retryable: false });
    expect(error.appError.message).toContain("or is enabled");
  });

  test("accepts remote URL paths and refuses credentials, query strings and fragments", async () => {
    const accepted = serviceFor('Added MCP server "remote" (user).');
    await accepted.service.action(
      mcpAction({
        operation: "add",
        operationId: "add-path",
        name: "remote",
        scope: "user",
        transport: "sse",
        url: "https://mcp.example.test/api/v1",
      }),
    );
    expect(accepted.calls[0]?.command).toContain("https://mcp.example.test/api/v1");

    for (const url of [
      "https://user:password@mcp.example.test/api/v1",
      "https://mcp.example.test/api/v1?token=secret",
      "https://mcp.example.test/api/v1#token",
      "https://mcp.example.test/api/v1?",
      "https://mcp.example.test/api/v1#",
    ]) {
      expect(
        McpCommandActionArgs.safeParse({
          threadId,
          operation: "add",
          operationId: "invalid-url",
          name: "remote",
          scope: "user",
          transport: "http",
          url,
        }).success,
      ).toBe(false);
    }
  });

  test("reports scope mismatch without claiming the other scope was changed", async () => {
    const { service } = serviceFor('Server "remote" enabled (user config).');
    const error = await appFailure(
      service.action(
        mcpAction({
          operation: "enable",
          operationId: "enable-1",
          name: "remote",
          scope: "project",
        }),
      ),
    );
    expect(error.appError.code).toBe("conflict");
    expect(error.appError.message).toContain("Refresh the server list");
  });

  test("only retries connection failures and keeps other command failures non-retryable", async () => {
    const connection = serviceFor(
      'Connection to "remote" failed: connect ECONNREFUSED 127.0.0.1:1234',
    );
    const connectionError = await appFailure(
      connection.service.action(
        mcpAction({
          operation: "test",
          operationId: "test-connect",
          name: "remote",
          scope: "user",
        }),
      ),
    );
    expect(connectionError.appError).toMatchObject({ code: "omp_error", retryable: true });

    const failed = serviceFor('Failed to enable MCP server "remote".');
    const failedError = await appFailure(
      failed.service.action(
        mcpAction({
          operation: "enable",
          operationId: "enable-failed",
          name: "remote",
          scope: "user",
        }),
      ),
    );
    expect(failedError.appError).toMatchObject({ code: "omp_error", retryable: false });
  });

  test("warns that a cancelled mutation may already have applied and requires list refresh", async () => {
    const runner: McpCommandRunner = {
      async run() {
        throw new AppFailure({
          code: "cancelled",
          message: "The call was cancelled.",
          retryable: false,
        });
      },
    };
    const service = new McpCommandsService(runner);
    const error = await appFailure(
      service.action(
        mcpAction({
          operation: "enable",
          operationId: "enable-cancelled",
          name: "remote",
          scope: "user",
        }),
      ),
    );
    expect(error.appError).toMatchObject({ code: "cancelled", retryable: false });
    expect(error.appError.message).toContain("may already have been applied");
    expect(error.appError.message).toContain("Refresh the server list");
  });

  test("does not expose reconnect as a server command", () => {
    expect(
      McpCommandActionArgs.safeParse({
        threadId,
        operation: "reconnect",
        operationId: "reconnect-1",
        name: "remote",
        scope: "user",
      }).success,
    ).toBe(false);
  });
});
