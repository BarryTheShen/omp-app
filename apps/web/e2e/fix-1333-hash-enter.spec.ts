import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/** The list a `#` opens in the message box: GitHub references and omp's action rows. */
function githubList(page: Page): Locator {
  return page.getByRole("listbox", { name: "GitHub suggestions" });
}

/** The messages the person sent, as the chat renders them. */
function userRows(page: Page): Locator {
  return page.locator('[data-slot="u1-message-row"][data-role="user"]');
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

/** Before a screenshot: the theme's background token is painted (index.css paints it on body; unstyled, body is transparent). */
async function expectStyled(page: Page): Promise<void> {
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "#1333: a heading closes the # list at its space, and Enter sends it, with no list in the way",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    // A bare # opens the list; the space after it makes the # a heading, so the list closes at once.
    await composer.pressSequentially("#");
    await expect(githubList(page)).toBeVisible();
    await composer.pressSequentially(" Plan");
    await expect(githubList(page)).toHaveCount(0);
    await expect(composer).toHaveValue("# Plan");
    await settle(page);
    await expectStyled(page);
    await page.screenshot({ path: join(screenshots, "fix-1333-heading-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await expectStyled(page);
    await page.screenshot({ path: join(screenshots, "fix-1333-heading-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await composer.press("Enter");
    await expect(composer).toHaveValue("", { timeout: 30_000 });
    await expect(userRows(page).filter({ hasText: "Plan" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    await settle(page);
    await expectStyled(page);
    await page.screenshot({ path: join(screenshots, "fix-1333-heading-sent-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1333: Enter pressed at once after a heading sends it, with no second Enter",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    // The Enter follows the typing at once, while a list would still be loading.
    await composer.pressSequentially("# Plan");
    await composer.press("Enter");
    await expect(composer).toHaveValue("", { timeout: 30_000 });
    await expect(userRows(page).filter({ hasText: "Plan" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1333: a heading after a line of prose is sent whole, not erased, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const composer = await startChat(page);
    await composer.pressSequentially("Notes first");
    await composer.press("Shift+Enter");
    await composer.pressSequentially("#");
    await expect(githubList(page)).toBeVisible();
    await composer.pressSequentially(" Plan");
    await expect(githubList(page)).toHaveCount(0);
    await expect(composer).toHaveValue("Notes first\n# Plan");
    // The dark class is on the page before the screenshot, so the theme is dark.
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
      true,
    );
    await settle(page);
    await expectStyled(page);
    await page.screenshot({ path: join(screenshots, "fix-1333-heading-dark.png") });
    await composer.press("Enter");
    await expect(composer).toHaveValue("", { timeout: 30_000 });
    const row = userRows(page).filter({ hasText: "Notes first" });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("Plan");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);
