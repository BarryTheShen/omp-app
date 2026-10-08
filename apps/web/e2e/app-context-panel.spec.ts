import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** Answers one prompt, then opens the Context tab. omp has reported the usage by then. */
async function openContextOfAnsweredChat(page: Page) {
  const composer = await startChat(page);
  await sendPrompt(composer, "pong");
  await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: "Context" }).click();
  await expect(page.getByText(/[\d.,k]+ \/ [\d.,k]+ tokens/)).toBeVisible({ timeout: 30_000 });
}

/** About 28,000 tokens. omp keeps the last 20,000 for a compaction, so the second turn's prompt leaves the first turn to summarize. */
const longPrompt = "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2_000);

realTest(
  "the Context tab shows the chat's context and compaction controls, auto-compaction toggles from the keyboard, and Compact now reports what it compacted",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, longPrompt);
    await expect(page.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });
    await sendPrompt(composer, longPrompt);
    await expect(page.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 60_000 });
    await page.getByRole("tab", { name: "Context" }).click();
    await expect(page.getByText(/[\d.,k]+ \/ [\d.,k]+ tokens/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Compact now" })).toBeVisible();
    const auto = page.getByRole("checkbox", { name: "Auto-compaction" });
    await auto.focus();
    const before = await auto.isChecked();
    await page.keyboard.press("Space");
    await expect(auto).toBeChecked({ checked: !before });
    await page.getByRole("button", { name: "Compact now" }).click();
    await expect(page.getByText(/^Compacted [\d,]+ tokens\.$/)).toBeVisible({ timeout: 120_000 });
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "app-context-panel-light.png"),
      fullPage: true,
    });
  },
);

realTest("the Context tab reads in dark and at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
  await page.reload();
  await openContextOfAnsweredChat(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("checkbox", { name: "Auto-compaction" })).toBeVisible();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "app-context-panel-dark.png"), fullPage: true });
  // At 390 px the Panels drawer is closed; open it, then the controls must be on screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show Panels sidebar" }).click();
  await expect(page.getByRole("checkbox", { name: "Auto-compaction" })).toBeInViewport();
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "app-context-panel-narrow.png"),
    fullPage: true,
  });
});
