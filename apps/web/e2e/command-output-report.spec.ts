import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** The lines omp printed for `/tools` with the fake model: one line per tool, in omp's order. */
const TOOLS_TEXT = [
  "* read",
  "* bash",
  "* edit",
  "- ast_edit",
  "* ask",
  "- debug",
  "* eval",
  "* glob",
  "* grep",
  "- lsp",
  "* task",
  "* wait",
  "* todo",
  "* web_search",
  "* write",
  "- goal",
  "- init_experiment",
  "- run_experiment",
  "- log_experiment",
  "- update_notes",
  "~ xd://ast_edit",
  "~ xd://debug",
  "~ xd://lsp",
].join("\n");

realTest(
  "/tools shows every line of omp's answer in the command output panel, which stays until it is closed",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    // The page's clock runs from the start, so the header's 8-second note can be run past at once instead of waited for.
    const page = await realApp.open({ beforeLoad: (target) => target.clock.install() });
    const composer = await startChat(page);
    await sendPrompt(composer, "/tools");

    const panel = page.getByRole("region", { name: "Command output" });
    await expect(panel).toBeVisible({ timeout: 60_000 });
    const block = panel.locator("pre");
    expect(await block.textContent()).toBe(TOOLS_TEXT);

    await page.clock.fastForward(10_000);
    await expect(panel).toBeVisible();
    expect(await block.textContent()).toBe(TOOLS_TEXT);

    // The text is plain selectable text: selecting the block selects every line, so it can be copied.
    const selected = await block.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() ?? "";
    });
    expect(selected).toBe(TOOLS_TEXT);
    // The selection was only the copy check: clear it so the screenshots show the panel as a person sees it.
    await block.evaluate(() => window.getSelection()?.removeAllRanges());

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "command-output-light.png") });

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "command-output-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });

    await panel.getByRole("button", { name: "Close Command output" }).click();
    await expect(panel).toBeHidden();
    await expect(composer).toBeFocused();

    // On a phone the answer opens in the Panels drawer by itself, and it shows no "New updates" jump on open.
    await page.setViewportSize({ width: 390, height: 844 });
    await sendPrompt(composer, "/tools");
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Jump to latest panel updates" })).toHaveCount(0);
    expect(await block.textContent()).toBe(TOOLS_TEXT);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "command-output-390.png") });
  },
);

/** `/mcp list` reads omp's MCP config and prints one line per server, so two servers make an answer of several lines. */
const MCP_LIST_TEXT = [
  "fixture-docs | stdio | enabled | bun [user]",
  "fixture-notes | stdio | enabled | bun [user]",
].join("\n");

realTest(
  "/mcp list with two servers shows a line for each in the command output panel",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const server = {
      type: "stdio",
      command: "bun",
      args: ["run", join(process.cwd(), "e2e", "i1-mcp-fake-server.ts")],
    };
    writeFileSync(
      realApp.mcpConfigPath,
      JSON.stringify({ mcpServers: { "fixture-docs": server, "fixture-notes": server } }, null, 2),
    );
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "/mcp list");

    const panel = page.getByRole("region", { name: "Command output" });
    await expect(panel).toBeVisible({ timeout: 60_000 });
    expect(await panel.locator("pre").textContent()).toBe(MCP_LIST_TEXT);
  },
);
