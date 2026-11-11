import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * Editing omp's MCP servers in Settings → Tools (#16), on real omp: a server added from the form lands in your MCP
 * file; edited, a saved secret the page never saw stays; turned off and on, and removed, each read back from the file;
 * JSON as an MCP page publishes it fills the form, and a folder's own server lands in that folder's file.
 */
const sheet = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const servers = (page: Page) => sheet(page).getByRole("region", { name: "MCP servers" });

type McpFile = { mcpServers?: Record<string, Record<string, unknown>> };
const readMcp = (path: string): McpFile => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as McpFile;
  } catch {
    return {};
  }
};

async function openTools(page: Page): Promise<void> {
  await startNewChat(page);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
    "placeholder",
    "Message omp",
    { timeout: 120_000 },
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await sheet(page)
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: /^Tools/ })
    .click();
  await expect(servers(page)).toContainText("No MCP servers yet", { timeout: 60_000 });
}

realTest.describe("new UI: editing MCP servers", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a server added from the form, edited with its saved secret kept, turned off and on, and removed",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await openTools(page);
      const file = () => readMcp(realApp.mcpConfigPath).mcpServers ?? {};

      await servers(page).getByRole("button", { name: "Add a server" }).click();
      const editor = page.getByRole("dialog", { name: "Add an MCP server" });
      // Exact labels: "Command" is also in "By starting a command", "Name" in "Variable 1 name".
      await editor.getByLabel("Name", { exact: true }).fill("files");
      await editor.getByLabel("Command", { exact: true }).fill("node");
      await editor.getByLabel("Arguments", { exact: true }).fill("server.js\n--root\n/srv");
      await editor.getByRole("button", { name: "Add a variable" }).click();
      await editor.getByLabel("Variable 1 name", { exact: true }).fill("TOKEN");
      await editor.getByLabel("Variable 1 value", { exact: true }).fill("s3cret");
      await editor.getByRole("button", { name: "Add", exact: true }).click();
      await expect(editor).toHaveCount(0);
      const row = servers(page).getByRole("listitem", { name: "files" });
      await expect(row).toContainText("Command · every folder", { timeout: 30_000 });
      await expect(row).toContainText("node server.js --root /srv");
      expect(file().files).toMatchObject({
        type: "stdio",
        command: "node",
        args: ["server.js", "--root", "/srv"],
        env: { TOKEN: "s3cret" },
      });

      // Edited: the saved secret is an empty field marked Saved, and stays as it was.
      await row.getByRole("button", { name: "Edit" }).click();
      const edit = page.getByRole("dialog", { name: "Edit files" });
      const secret = edit.getByLabel("Variable 1 value", { exact: true });
      await expect(secret).toHaveValue("");
      await expect(secret).toHaveAttribute("placeholder", "Saved; type to replace");
      await edit
        .getByLabel("Arguments", { exact: true })
        .fill("server.js\n--root\n/srv\n--verbose");
      await edit.getByRole("button", { name: "Save" }).click();
      await expect(edit).toHaveCount(0);
      await expect(row).toContainText("node server.js --root /srv --verbose", { timeout: 30_000 });
      expect(file().files).toMatchObject({
        args: ["server.js", "--root", "/srv", "--verbose"],
        env: { TOKEN: "s3cret" },
      });

      // Off, then on.
      const on = row.getByRole("switch", { name: "files on" });
      await on.click();
      await expect(row).toContainText("off", { timeout: 30_000 });
      expect(file().files?.enabled).toBe(false);
      await on.click();
      await expect(row).not.toContainText("· off", { timeout: 30_000 });
      expect(file().files?.enabled).toBe(true);

      // Removed, after a confirmation.
      await row.getByRole("button", { name: "Remove" }).click();
      await page
        .getByRole("alertdialog", { name: "Remove files?" })
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      expect(file().files).toBeUndefined();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "JSON from a server's page fills the form, and a folder's own server lands in that folder's file",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await openTools(page);

      await servers(page).getByRole("button", { name: "Add a server" }).click();
      const editor = page.getByRole("dialog", { name: "Add an MCP server" });
      await editor.getByRole("button", { name: "JSON" }).click();
      await editor.getByLabel("The server's JSON", { exact: true }).fill(
        JSON.stringify({
          mcpServers: {
            docs: {
              url: "https://docs.example.com/mcp",
              headers: { Authorization: "Bearer t" },
            },
            other: { command: "uvx", args: ["mcp-server-time"] },
          },
        }),
      );
      await editor.getByRole("button", { name: "Fill the form" }).click();
      await expect(editor.getByRole("status")).toHaveText(
        "This JSON has 2 servers: the form has the first, docs. Add the others one at a time.",
      );
      await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("docs");
      await expect(editor.getByRole("radio", { name: "At an address, over HTTP" })).toBeChecked();
      await expect(editor.getByLabel("Address", { exact: true })).toHaveValue(
        "https://docs.example.com/mcp",
      );
      await editor.getByRole("radio", { name: "This folder only" }).click();
      await editor.getByRole("button", { name: "Add", exact: true }).click();
      await expect(editor).toHaveCount(0);

      const row = servers(page).getByRole("listitem", { name: "docs" });
      await expect(row).toContainText("HTTP · this folder", { timeout: 30_000 });
      expect(readMcp(join(realApp.folder, ".omp", "mcp.json")).mcpServers?.docs).toMatchObject({
        type: "http",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: "Bearer t" },
      });
      expect(readMcp(realApp.mcpConfigPath).mcpServers?.docs).toBeUndefined();
      expect(realApp.problems).toEqual([]);
    },
  );
});
