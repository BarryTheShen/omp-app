import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #834. A search that matched nothing in a folder with 12 chats said "No sessions in this
 * folder" and offered a New chat button, as if the chats were gone. It now names the search, offers
 * no New chat button, and the folder's chats come back once the search is cleared.
 */
realTest.use({ seedSessions: 12 });

const NO_MATCH = 'No chats match "zzzz"';

/** Types a search that matches no chat, and checks the list says so without the folder's prompt. */
async function searchWithoutMatch(page: Page): Promise<void> {
  const sidebar = page.getByRole("complementary", { name: "Session list" });
  await expect(sidebar.getByRole("option").first()).toBeVisible({ timeout: 30_000 });
  await sidebar.getByRole("textbox", { name: "Search sessions" }).fill("zzzz");
  await expect(sidebar.getByText(NO_MATCH, { exact: true })).toBeVisible();
  await expect(sidebar.getByText("No sessions in this folder")).toHaveCount(0);
  await expect(sidebar.getByText("Start a new chat to create an omp session.")).toHaveCount(0);
}

realTest(
  "real omp: a search with no match names the search, and clearing it brings the chats back",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await searchWithoutMatch(page);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-834-search-empty-light.png") });

    const sidebar = page.getByRole("complementary", { name: "Session list" });
    await sidebar.getByRole("textbox", { name: "Search sessions" }).fill("");
    await expect(
      sidebar.getByRole("listbox", { name: "Session list" }).getByRole("option").first(),
    ).toContainText("Seeded chat 12");
  },
);

realTest("real omp: the no-match search reads in dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await searchWithoutMatch(page);
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "fix-834-search-empty-dark.png") });
});

realTest("real omp: the no-match search reads at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show sessions sidebar" }).click();
  await searchWithoutMatch(page);
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "fix-834-search-empty-390.png") });
});
