import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

// #2263 (part of #2175): the first `/` and a typed command read only omp's own command list. Three stdio MCP servers
// that take 1.5 s to start are configured, the setup of the owner's workspace. Before this change the app read every MCP
// prompt for each chat, so the first `/` and the first typed command waited about 5 s for those servers to start.

const STUB = resolve(process.cwd(), "e2e/fix-2263-mcp-stub.ts");
const OPTIONS = '[aria-label="Slash commands"] [role="option"]';

interface Frame {
  readonly at: number;
  readonly text: string;
}

/** Three stdio servers that take 1.5 s to start, each start logged to `log`. */
function writeSlowServers(configPath: string, log: string): void {
  const mcpServers = Object.fromEntries(
    [1, 2, 3].map((n) => [
      `stub${n}`,
      { type: "stdio", command: "bun", args: ["run", STUB, "1500", log] },
    ]),
  );
  writeFileSync(configPath, JSON.stringify({ mcpServers }));
}

/** Keeps every WebSocket frame of the page from its first load, with the time it moved. */
async function recordFrames(page: Page, frames: Frame[]): Promise<void> {
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => frames.push({ at: Date.now(), text: String(event.payload) }));
    socket.on("framereceived", (event) =>
      frames.push({ at: Date.now(), text: String(event.payload) }),
    );
  });
}

/** Stamps, in the page, the time of the `/` keystroke and of the first row that follows it. */
async function markFirstRow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.documentElement;
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "/") return;
        root.dataset.keyAt = String(Date.now());
        delete root.dataset.optionAt;
      },
      true,
    );
    new MutationObserver(() => {
      const row = document.querySelector('[aria-label="Slash commands"] [role="option"]');
      if (row && root.dataset.keyAt !== undefined && root.dataset.optionAt === undefined) {
        root.dataset.optionAt = String(Date.now());
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

async function marks(page: Page): Promise<{ keyAt: number; optionAt: number }> {
  const read = await page.evaluate(() => {
    const data = document.documentElement.dataset;
    return { keyAt: data.keyAt, optionAt: data.optionAt };
  });
  expect(read.keyAt, "the keystroke was stamped").toBeDefined();
  expect(read.optionAt, "the first row was stamped").toBeDefined();
  return { keyAt: Number(read.keyAt), optionAt: Number(read.optionAt) };
}

/** How many times an MCP server was started at or after `at` (the stub logs `<ms> spawn pid=<n>`). */
function serversStartedAfter(log: string, at: number): number {
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => / spawn pid=/u.test(line))
    .filter((line) => Number(line.split(" ")[0]) >= at).length;
}

/** Opens a new chat and waits until its composer accepts input: the state the probe timed from. */
async function settledChat(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await expect.poll(() => composer.isEnabled(), { timeout: 60_000, intervals: [20] }).toBe(true);
  return composer;
}

realTest(
  "the first / of a settled chat shows omp's rows within 600 ms, and no MCP server is started for it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const log = join(realApp.appDataDir, "mcp-stub.log");
    writeSlowServers(realApp.mcpConfigPath, log);
    const frames: Frame[] = [];
    const page = await realApp.open({
      beforeLoad: (loading) => recordFrames(loading, frames),
    });
    const composer = await settledChat(page);
    const chatOpenedAt = Date.now();
    await markFirstRow(page);
    await page.waitForTimeout(3_000);

    await composer.pressSequentially("/");
    await expect(page.locator(OPTIONS).first()).toBeVisible({ timeout: 20_000 });
    const { keyAt, optionAt } = await marks(page);
    const firstRowMs = optionAt - keyAt;
    console.log(`FIRSTLIST settled first-row-ms=${firstRowMs}`);
    expect(firstRowMs).toBeLessThanOrEqual(600);

    const mcpFrames = frames.filter(
      (frame) => frame.at >= keyAt && frame.text.includes("A1.mcpCommands"),
    );
    expect(mcpFrames.map((frame) => frame.text.slice(0, 160))).toEqual([]);
    expect(serversStartedAfter(log, keyAt), "MCP servers started after the keystroke").toBe(0);

    // M3: does omp list MCP prompts itself once its own read is over? Each row shows once.
    await page.waitForTimeout(Math.max(0, chatOpenedAt + 15_000 - Date.now()));
    await composer.fill("");
    await composer.pressSequentially("/");
    await expect(page.locator(OPTIONS).first()).toBeVisible({ timeout: 20_000 });
    const rows = await page.locator(OPTIONS).allInnerTexts();
    const mcpRows = rows.filter((text) => text.includes("MCP prompt"));
    console.log(`FIRSTLIST m3 rows=${rows.length} mcp-prompt-rows=${mcpRows.length}`);
    expect(new Set(rows).size).toBe(rows.length);
  },
);

realTest(
  "a command typed and sent at once in a fresh chat answers within 1.5 s, with three slow MCP servers configured",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    writeSlowServers(realApp.mcpConfigPath, join(realApp.appDataDir, "mcp-stub.log"));
    const page = await realApp.open();
    const composer = await settledChat(page);
    await page.waitForTimeout(3_000);

    const enterAt = Date.now();
    await composer.fill("/context");
    await composer.press("Enter");
    await expect(page.getByRole("region", { name: "Command output" })).toBeVisible({
      timeout: 30_000,
    });
    const enterToOutputMs = Date.now() - enterAt;
    console.log(`FIRSTLIST context enter-to-output-ms=${enterToOutputMs}`);
    expect(enterToOutputMs).toBeLessThanOrEqual(1500);
  },
);
