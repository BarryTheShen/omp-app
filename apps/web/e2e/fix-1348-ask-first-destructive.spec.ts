import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";
import { sendTyped } from "./share-stub";

/**
 * Issue #1348. A typed `/mcp remove` deletes a named MCP server's entry when omp runs it, so the app asks first: the
 * question names the server, Cancel sends nothing to omp, and Confirm sends the command once. The server here does not
 * exist, so nothing is deleted whichever answer is given.
 */

const SERVER = "nope";

/** The question the typed command opens: its accessible name is the form's label. */
function question(page: Page): Locator {
  return page.getByRole("dialog", { name: "Remove MCP server" });
}

/** omp's reply to a command, shown in the header. */
function commandReply(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: "omp:" });
}

realTest(
  "#1348: a typed /mcp remove asks first and names the server; Cancel sends nothing to omp, Confirm sends it once",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const composer = await startChat(page);

    await sendTyped(page, composer, `/mcp remove ${SERVER}`);
    await expect(question(page)).toBeVisible();
    await expect(
      question(page).getByText(`Remove the MCP server "${SERVER}" from the project config?`),
    ).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1348-mcp-remove-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1348-mcp-remove-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1348-mcp-remove-narrow.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Cancel sends nothing. A prompt sent after it is answered by omp in the same session, so once that answer shows,
    // any command sent before it has been answered too, and no reply to the command may be there.
    await question(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question(page)).toHaveCount(0);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(1);
    await expect(commandReply(page)).toHaveCount(0);

    // Confirm sends the command once, and omp's reply shows in the header.
    await sendTyped(page, composer, `/mcp remove ${SERVER}`);
    await question(page).getByRole("button", { name: "Remove server", exact: true }).click();
    await expect(commandReply(page)).toBeVisible({ timeout: 30_000 });
    expect(realApp.problems).toEqual([]);
  },
);
