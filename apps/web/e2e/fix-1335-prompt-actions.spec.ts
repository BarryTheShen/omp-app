import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/** The list the `#` opens above the message box: omp's action rows, and GitHub references when the search answers. */
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
  "#1335: Move cursor to start removes the # and puts the caret at the start of the message",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await composer.pressSequentially("hello #");
    await expect(githubList(page)).toBeVisible();
    await expect(page.getByText("Move cursor to start", { exact: true })).toBeVisible();
    await expect(page.getByText("Copy current line", { exact: true })).toBeVisible();
    await expectStyled(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1335-actions-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1335-actions-dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    // Narrowing closes both sidebars as drawers (the shell's own rule); wait until they are shut before the capture.
    for (const side of ["left", "right"] as const) {
      const sidebar = page.locator(`[data-shell-sidebar="${side}"]`);
      await expect(sidebar).toHaveAttribute("data-open", "false");
      await expect(sidebar).toBeHidden();
    }
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1335-actions-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByText("Move cursor to start", { exact: true }).click();
    await expect(composer).toHaveValue("hello ");
    await composer.pressSequentially("x");
    await expect(composer).toHaveValue("xhello ");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1335: Copy current line copies the line the # sits on, without the #, and says so",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    const composer = await startChat(page);
    await composer.pressSequentially("first line");
    await composer.press("Shift+Enter");
    await composer.pressSequentially("second #");
    await page.getByText("Copy current line", { exact: true }).click();
    await expect(composer).toHaveValue("first line\nsecond ");
    await expect(page.getByText("Copied the current line.", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("second ");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1335: Undo reverts the last word typed before the #, and says so when nothing is left",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("hello world #");
    await page.getByText("Undo", { exact: true }).click();
    await expect(composer).toHaveValue("hello ");
    await composer.pressSequentially("#");
    await page.getByText("Undo", { exact: true }).click();
    // The step before, the word "hello ", is what the second Undo reverts.
    await expect(composer).toHaveValue("");
    await composer.pressSequentially("#");
    await page.getByText("Undo", { exact: true }).click();
    await expect(composer).toHaveValue("");
    await expect(page.getByText("There is nothing to undo.", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest.describe("with GitHub search failing", () => {
  realTest.use({
    serverEnv: {
      PATH: `${resolve(process.cwd(), "e2e/fake-gh-failing")}:${process.env.PATH ?? ""}`,
    },
  });

  realTest(
    "#1335: when the search fails, its reason shows in place of a row, and Enter sends the text",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      await mkdir(screenshots, { recursive: true });
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
      });
      const composer = await startChat(page);
      await composer.pressSequentially("see #12");
      await expect(
        page.getByRole("status").filter({ hasText: "GitHub CLI could not complete the request." }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(githubList(page).getByRole("option")).toHaveCount(0);
      await expectStyled(page);
      await settle(page);
      await page.screenshot({ path: join(screenshots, "fix-1335-status-light.png") });
      await composer.press("Enter");
      await expect(composer).toHaveValue("", { timeout: 30_000 });
      await expect(userRows(page).filter({ hasText: "see" })).toBeVisible({ timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
