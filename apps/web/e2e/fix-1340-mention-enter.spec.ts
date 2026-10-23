import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/** The GitHub suggestions list above the message box. */
function githubList(page: Page): Locator {
  return page.getByRole("listbox", { name: "GitHub suggestions" });
}

/** The messages the person sent, as the chat renders them. */
function userRows(page: Page): Locator {
  return page.locator('[data-slot="u1-message-row"][data-role="user"]');
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  const timer = setTimeout(done, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

/** Switches the page between light and dark, as the app's theme does, and lets it settle. */
async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

/** Styles have loaded: the page background is the theme's token, not the browser's default. */
async function expectStyled(page: Page): Promise<void> {
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "#1340: a reference with text after it sends on Enter, and the whole message is kept",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await composer.pressSequentially("see #12");
    await expect(page.getByText("PR #12", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(githubList(page)).toBeVisible();
    await expectStyled(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1340-list-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1340-list-dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    // Narrowing closes both sidebars as drawers (the shell's own rule); wait until they are shut before the capture.
    for (const side of ["left", "right"] as const) {
      const sidebar = page.locator(`[data-shell-sidebar="${side}"]`);
      await expect(sidebar).toHaveAttribute("data-open", "false");
      await expect(sidebar).toBeHidden();
    }
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1340-list-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await composer.focus();
    await composer.press("End");
    await composer.pressSequentially(" for details");
    await expect(githubList(page)).toHaveCount(0);
    await expect(composer).toHaveValue("see #12 for details");
    await composer.press("Enter");
    await expect(composer).toHaveValue("", { timeout: 30_000 });
    await expect(userRows(page).filter({ hasText: "for details" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1340-sent-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1340: Enter pressed at once after a reference with text after it sends the whole message",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("see #12 for details");
    await composer.press("Enter");
    await expect(composer).toHaveValue("", { timeout: 30_000 });
    await expect(userRows(page).filter({ hasText: "for details" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1340: Enter on a found reference still inserts its link, and sends nothing",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("see #12");
    await expect(page.getByText("PR #12", { exact: true })).toBeVisible({ timeout: 30_000 });
    await composer.press("Enter");
    await expect(composer).toHaveValue("see pr://12 ", { timeout: 30_000 });
    await expect(userRows(page)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
