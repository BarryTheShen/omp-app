/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensurePlaygroundBuilt } from "./playground-build";
import { expect, realOmpEnabled, realTest } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const FAKE_MCP_SERVER = join(APP_ROOT, "e2e", "i1-mcp-fake-server.ts");
const MCP_SERVER_NAME = "cloudflare:cloudflare-api";
const ADDED_SERVER_NAME = "maas-slack";
const MCP_CONFIG_CHECK_KEY = "omp-app-i1-mcp-config-checked";
const MCP_CONFIG = z
  .object({
    mcpServers: z.record(
      z.string(),
      z
        .object({
          type: z.string().optional(),
          command: z.string(),
          args: z.array(z.string()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function buildMcpPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/I1/protocol/e2e-playground.ts",
      "--outfile",
      "dist/i1-mcp-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  writeFileSync(
    join(DIST_ROOT, "i1-mcp-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>MCP integration test</title>
  </head>
  <body>
    <script type="module" src="/i1-mcp-playground.js"></script>
  </body>
</html>
`,
  );
}

realTest.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    if (!realOmpEnabled) return;
    buildMcpPlayground();
  }),
);

realTest("uses live MCP catalogs and host registrations with real omp", async ({ realApp }) => {
  writeFileSync(
    realApp.mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: "stdio",
            command: "bun",
            args: ["run", FAKE_MCP_SERVER],
          },
        },
      },
      null,
      2,
    ),
  );
  const page = await realApp.open();
  const playgroundUrl = new URL("/i1-mcp-playground.html", page.url());
  playgroundUrl.searchParams.set("mcpServer", FAKE_MCP_SERVER);
  await page.goto(playgroundUrl.toString());

  const root = page.locator("html");
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.i1McpTestStage === "added" ||
      document.documentElement.dataset.i1McpTestStatus === "failed",
    undefined,
    { timeout: 90_000 },
  );
  const stageStatus = await root.getAttribute("data-i1-mcp-test-status");
  if (stageStatus !== "running") {
    const detail = await root.getAttribute("data-i1-mcp-test-error");
    throw new Error(`The MCP integration failed before add: ${detail ?? "no detail."}`);
  }
  if ((await root.getAttribute("data-i1-mcp-test-stage")) !== "added") {
    const detail = await root.getAttribute("data-i1-mcp-test-error");
    throw new Error(`The MCP server was not added: ${detail ?? "no detail."}`);
  }

  const configAtAddValue: unknown = JSON.parse(readFileSync(realApp.mcpConfigPath, "utf8"));
  const configAtAdd = MCP_CONFIG.safeParse(configAtAddValue);
  if (!configAtAdd.success)
    throw new Error("The harness MCP configuration was not valid after add.");
  const addedServerConfig = configAtAdd.data.mcpServers[ADDED_SERVER_NAME];
  if (addedServerConfig === undefined) throw new Error("The added MCP server name was not stored.");
  expect(addedServerConfig).toMatchObject({
    type: "stdio",
    command: "bun",
    args: ["run", FAKE_MCP_SERVER, "hello world", "it's", "$shell", "`tick`", 'say "hi"'],
  });
  await page.evaluate(
    (key) => window.sessionStorage.setItem(key, "continue"),
    MCP_CONFIG_CHECK_KEY,
  );

  await expect
    .poll(() => root.getAttribute("data-i1-mcp-test-status"), { timeout: 90_000 })
    .toMatch(/^(complete|failed)$/);
  const status = await root.getAttribute("data-i1-mcp-test-status");
  if (status !== "complete") {
    const detail = await root.getAttribute("data-i1-mcp-test-error");
    throw new Error(`The MCP integration failed: ${detail ?? "no failure detail was reported."}`);
  }
  const result = await root.getAttribute("data-i1-mcp-test-result");
  if (result === null) throw new Error("The MCP integration result was not available.");
  expect(JSON.parse(result)).toEqual({
    hostMcp: "available",
    serverCount: 1,
    serverName: MCP_SERVER_NAME,
    serverCommand: "bun",
    promptCount: 3,
    multilineDescription: "First line of a docstring.\n\nArgs:\n    topic: what to explain",
    resourceCount: 3,
    privateResourceUris: ["file://<private-path>/a.md", "file://<private-path>/b.md"],
    privateResourceIdsDistinct: true,
    remoteResourceUri: "https://api.example.test/data",
    notificationState: "unavailable",
    serverTestMessage: "Connected to the MCP server. Found 1 tool.",
    typedToolsRegistered: true,
    typedSchemesRegistered: true,
    rawRegistryMerged: true,
    missingDescriptionRejected: true,
    addedServerName: ADDED_SERVER_NAME,
    updatedServerCount: 2,
    removedServerCount: 1,
    removedServerStatus: "disabled",
  });

  const finalConfigValue: unknown = JSON.parse(readFileSync(realApp.mcpConfigPath, "utf8"));
  const finalConfig = MCP_CONFIG.safeParse(finalConfigValue);
  if (!finalConfig.success)
    throw new Error("The harness MCP configuration was not valid after remove.");
  expect(Object.keys(finalConfig.data.mcpServers)).toEqual([MCP_SERVER_NAME]);
});
