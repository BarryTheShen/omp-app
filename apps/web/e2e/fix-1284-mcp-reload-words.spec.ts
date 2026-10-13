import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";
import { sendTyped } from "./share-stub";

/**
 * Issue #1284. A typed `/mcp reload` refreshes omp's command list over RPC and reconnects no MCP server. The header says
 * that in the app's own words, and does not say that the servers were reloaded.
 */

const REFRESHED =
  "The command list was refreshed. MCP servers were not reconnected: that needs omp's terminal.";

/** The header's note about the command: its status line. */
function note(page: Page) {
  return page.getByRole("status").filter({ hasText: REFRESHED });
}

realTest(
  "#1284: a typed /mcp reload says the command list was refreshed and that no MCP server reconnected",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const composer = await startChat(page);

    await sendTyped(page, composer, "/mcp reload");
    await expect(note(page)).toBeVisible({ timeout: 60_000 });
    // omp's own sentence, and any claim that the servers were reloaded, are not shown.
    await expect(page.getByText("MCP runtime reload requested.")).toHaveCount(0);
    await expect(page.getByText("MCP servers reloaded.")).toHaveCount(0);

    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1284-mcp-reload-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(note(page)).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1284-mcp-reload-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(note(page)).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1284-mcp-reload-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
