import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FolderPath, MCP_SECRET_MASK } from "@omp-app/contracts";
import { McpConfigService } from "./service";

let root: string | null = null;
afterEach(async () => {
  if (root !== null) await rm(root, { recursive: true, force: true });
  root = null;
});

/** An agent folder with a user `mcp.json` holding `servers` (and `more` of the file), and a project folder with none. */
async function setup(servers: Record<string, unknown>, more: Record<string, unknown> = {}) {
  root = await mkdtemp(join(tmpdir(), "omp-app-mcp-config-"));
  const agentDir = join(root, "agent");
  const folder = join(root, "project") as FolderPath;
  await mkdir(agentDir, { recursive: true });
  await mkdir(folder, { recursive: true });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers, ...more }));
  const read = async () =>
    JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
  return { service: new McpConfigService(agentDir), folder, read };
}

describe("omp's MCP config files (#16)", () => {
  test("a page gets env and header values masked; a masked value sent back keeps the saved secret", async () => {
    const { service, folder, read } = await setup(
      {
        local: { command: "npx", args: ["-y", "server"], env: { TOKEN: "s3cret", EMPTY: "" } },
        remote: {
          type: "http",
          url: "https://mcp.example.com/v1",
          headers: { Authorization: "Bearer x" },
        },
        // A name omp's own code refuses: left out of the list, and left in the file.
        "bad/name": { command: "x" },
      },
      { disabledServers: ["remote"] },
    );
    const { servers } = await service.servers(folder);
    expect(servers.map((server) => [server.name, server.scope, server.config])).toEqual([
      [
        "local",
        "user",
        {
          type: "stdio",
          command: "npx",
          args: ["-y", "server"],
          env: { TOKEN: MCP_SECRET_MASK, EMPTY: "" },
        },
      ],
      [
        "remote",
        "user",
        {
          type: "http",
          url: "https://mcp.example.com/v1",
          headers: { Authorization: MCP_SECRET_MASK },
          enabled: false,
        },
      ],
    ]);

    // New args, a new variable, and the saved token sent back masked.
    await service.save({
      folder,
      scope: "user",
      name: "local",
      previousName: null,
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "server", "--verbose"],
        env: { TOKEN: MCP_SECRET_MASK, MODE: "fast" },
      },
    });
    const saved = (await read()).mcpServers;
    expect(saved.local).toMatchObject({
      command: "npx",
      args: ["-y", "server", "--verbose"],
      env: { TOKEN: "s3cret", MODE: "fast" },
    });
    expect(saved["bad/name"]).toEqual({ command: "x" });
  });

  test("a rename writes the new name and removes the old; the other servers stay as they were", async () => {
    const { service, folder, read } = await setup({
      old: { command: "node", args: ["a.js"], env: { KEY: "k" } },
      other: { command: "deno", args: ["b.ts"] },
    });
    await service.save({
      folder,
      scope: "user",
      name: "renamed",
      previousName: "old",
      config: { type: "stdio", command: "node", args: ["a.js"], env: { KEY: MCP_SECRET_MASK } },
    });
    const { mcpServers } = await read();
    expect(Object.keys(mcpServers).sort()).toEqual(["other", "renamed"]);
    expect(mcpServers.renamed).toMatchObject({ command: "node", env: { KEY: "k" } });
    expect(mcpServers.other).toEqual({ command: "deno", args: ["b.ts"] });
  });

  test("a masked value under a key with nothing saved, and a bad name, are refused in words", async () => {
    const { service, folder, read } = await setup({
      local: { command: "npx", env: { TOKEN: "t" } },
    });
    await expect(
      service.save({
        folder,
        scope: "user",
        name: "local",
        previousName: null,
        config: { type: "stdio", command: "npx", env: { RENAMED: MCP_SECRET_MASK } },
      }),
    ).rejects.toThrow("Type the value of the variable RENAMED again");
    await expect(
      service.save({
        folder,
        scope: "user",
        name: "bad/name",
        previousName: null,
        config: { type: "stdio", command: "npx" },
      }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect((await read()).mcpServers).toEqual({ local: { command: "npx", env: { TOKEN: "t" } } });
  });

  test("a server added to the folder's file, turned off and on, and removed", async () => {
    const { service, folder } = await setup({});
    await service.save({
      folder,
      scope: "project",
      name: "docs",
      previousName: null,
      config: { type: "sse", url: "https://docs.example.com/sse" },
    });
    const listed = async () =>
      (await service.servers(folder)).servers.map((server) => [
        server.name,
        server.scope,
        server.config.enabled,
      ]);
    expect(await listed()).toEqual([["docs", "project", undefined]]);
    await service.setEnabled({ folder, scope: "project", name: "docs", enabled: false });
    expect(await listed()).toEqual([["docs", "project", false]]);
    await service.setEnabled({ folder, scope: "project", name: "docs", enabled: true });
    expect(await listed()).toEqual([["docs", "project", true]]);
    await service.remove({ folder, scope: "project", name: "docs" });
    expect(await listed()).toEqual([]);
  });
});
