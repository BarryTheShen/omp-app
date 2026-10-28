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

const NARROW = { width: 390, height: 844 } as const;

/**
 * Issue 852 on the real app: after omp writes a two-item todo list, the right panel's Todo checklist
 * tab shows the title once, as the panel's heading, with the progress line under it.
 */

/** The fake model writes the two-item list; the turn ends once omp has saved it. */
async function writeTodos(page: Page): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, "Please make_todos for the release.");
  await expect(page.getByText("Assistant is working…")).toBeHidden({ timeout: 45_000 });
}

/**
 * Shows the right sidebar if it is closed (it starts closed on a first run, #2570), then opens its Todo checklist tab,
 * which lists what omp wrote.
 */
async function openTodoTab(page: Page): Promise<Locator> {
  const show = page.getByRole("button", { name: /show panels sidebar/i });
  if ((await show.count()) > 0) await show.first().click();
  const sidebar = page.locator('[data-shell-sidebar="right"]');
  await sidebar.getByRole("tab", { name: "Todo checklist" }).click();
  await expect(sidebar.getByText("Write the thing").first()).toBeVisible();
  return sidebar;
}

/** The sidebar's styles are loaded (a token background, not the browser default) before a capture. */
async function expectStylesLoaded(page: Page, sidebar: Locator): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute(
    "href",
    /\/assets\/.+\.css$/,
  );
  const background = await sidebar.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/** One heading named "Todo checklist" on the whole page: the panel's own title. */
async function expectTitleOnce(page: Page, sidebar: Locator): Promise<void> {
  await expect(page.getByRole("heading", { name: "Todo checklist" })).toHaveCount(1);
  await expect(sidebar.getByRole("heading", { name: "Todo checklist" })).toBeVisible();
  await expect(sidebar.getByTestId("todo-progress")).toHaveText(/\d+ of 2 done/);
}

realTest(
  "the Todo checklist panel shows its title once, above the progress line (light)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await writeTodos(page);
    const sidebar = await openTodoTab(page);
    await expectTitleOnce(page, sidebar);
    await expectStylesLoaded(page, sidebar);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-852-todo-light.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the Todo checklist panel shows its title once in dark mode",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await writeTodos(page);
    const sidebar = await openTodoTab(page);
    await expectTitleOnce(page, sidebar);
    await expectStylesLoaded(page, sidebar);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-852-todo-dark.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the Todo checklist panel shows its title once at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await writeTodos(page);
    await page.setViewportSize(NARROW);
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    const sidebar = await openTodoTab(page);
    await expect(page.locator('[data-panel-layout="drawer"]')).toBeVisible();
    await expectTitleOnce(page, sidebar);
    await expectStylesLoaded(page, sidebar);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-852-todo-narrow.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);
