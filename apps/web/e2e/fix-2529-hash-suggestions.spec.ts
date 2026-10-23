import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 2529: the list a `#` opens was named "GitHub suggestions" even when it showed omp's action rows. omp keeps
 * those rows for a bare `#` and for a word after it (packages/tui/src/prompt/prompt-action-autocomplete.ts:173-195),
 * so that list is headed "Message actions". A `#<number>` offers omp's PR and Issue rows, built locally with no network
 * at suggestion time (packages/tui/src/prompt/github-ref-autocomplete.ts:61-74), so a missing or refused GitHub CLI
 * changes nothing and no unavailable row shows. Naming the type (`pr #n`) offers only that kind.
 */

/** The list a `#` opens for omp's action rows: a bare `#`, or a word after it. */
function messageActions(page: Page): Locator {
  return page.getByRole("listbox", { name: "Message actions" });
}

/** The list a `#` opens for a reference: a number, or a pr or issue search. */
function githubSuggestions(page: Page): Locator {
  return page.getByRole("listbox", { name: "GitHub suggestions" });
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
  "a bare # lists omp's action rows under the heading Message actions, never GitHub suggestions (issue 2529)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await composer.pressSequentially("hello #");
    await expect(messageActions(page)).toBeVisible();
    await expect(githubSuggestions(page)).toHaveCount(0);
    await expect(page.getByText("Copy current line", { exact: true })).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);

realTest.describe("with GitHub CLI refused", () => {
  realTest.use({
    serverEnv: {
      PATH: `${resolve(process.cwd(), "e2e/fake-gh-failing")}:${process.env.PATH ?? ""}`,
    },
  });

  realTest(
    "#123 offers omp's PR and Issue rows with the GitHub CLI refused, and shows no unavailable row (issue 2529)",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      await mkdir(screenshots, { recursive: true });
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
      });
      const composer = await startChat(page);
      await composer.pressSequentially("see #123");
      await expect(page.getByText("PR #123", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Issue #123", { exact: true })).toBeVisible();
      await expect(page.getByText("GitHub pull request", { exact: true })).toBeVisible();
      await expect(githubSuggestions(page)).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "GitHub CLI" })).toHaveCount(0);
      await expectStyled(page);
      await settle(page);
      await page.screenshot({ path: join(screenshots, "fix-2529-number-light.png") });
      await setTheme(page, true);
      await page.screenshot({ path: join(screenshots, "fix-2529-number-dark.png") });
      await setTheme(page, false);
      await page.setViewportSize({ width: 390, height: 844 });
      await settle(page);
      await page.screenshot({ path: join(screenshots, "fix-2529-number-narrow.png") });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByText("Issue #123", { exact: true }).click();
      await expect(composer).toHaveValue("see issue://123 ");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("pr #123 offers only omp's PR row (issue 2529)", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("pr #123");
    await expect(page.getByText("PR #123", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Issue #123", { exact: true })).toHaveCount(0);
    await page.getByText("PR #123", { exact: true }).click();
    await expect(composer).toHaveValue("pr://123 ");
    expect(realApp.problems).toEqual([]);
  });
});
