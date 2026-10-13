import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 1436: the `#` action list is omp's. Its seven rows carry omp's labels (omp's source:
 * packages/tui/src/prompt/prompt-action-autocomplete.ts, v18.6.1, lines 284-334), and the two line moves put the caret
 * on the line the `#` sits on. Captures: light, dark and 390 px wide.
 */

/** omp's rows, in the order the list shows them. */
const ROWS = [
  "Copy current line",
  "Copy whole prompt",
  "Undo",
  "Move cursor to message start",
  "Move cursor to message end",
  "Move cursor to line start",
  "Move cursor to line end",
];

/** The plain description under each row: what the row does, in words. */
const DESCRIPTIONS = [
  "Copies the line the cursor is on",
  "Copies everything typed so far",
  "Takes back the last word typed",
  "Moves the cursor to the start of the message",
  "Moves the cursor to the end of the message",
  "Moves the cursor to the start of this line",
  "Moves the cursor to the end of this line",
];

/** The list the `#` opens above the message box. */
function actionList(page: Page): Locator {
  return page.getByRole("listbox", { name: "GitHub suggestions" });
}

/** Switches the page between light and dark, as the app's theme does, and lets it settle. */
async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

realTest(
  "#1436: the # list has omp's seven rows, with both line moves",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await composer.pressSequentially("hello #");
    await expect(actionList(page)).toBeVisible();
    for (const row of ROWS) {
      await expect(
        page.getByText(row, { exact: true }),
        `the list has the row "${row}"`,
      ).toBeVisible();
    }
    for (const description of DESCRIPTIONS) {
      await expect(
        page.getByText(description, { exact: true }),
        `the list says "${description}"`,
      ).toBeVisible();
    }
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1436-actions-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1436-actions-dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    // Narrowing closes both sidebars as drawers; wait until both report closed before the narrow capture.
    for (const side of ["left", "right"] as const) {
      const sidebar = page.locator(`[data-shell-sidebar="${side}"]`);
      await expect(sidebar).toHaveAttribute("data-open", "false");
      await expect(sidebar).toBeHidden();
    }
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1436-actions-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1436: Move cursor to line start puts the caret at the start of the line the # sits on",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("first line");
    await composer.press("Shift+Enter");
    await composer.pressSequentially("second line #");
    await expect(actionList(page)).toBeVisible();
    await page.getByText("Move cursor to line start", { exact: true }).click();
    await expect(composer).toHaveValue("first line\nsecond line ");
    await composer.pressSequentially("x");
    await expect(composer).toHaveValue("first line\nxsecond line ");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1436: Move cursor to line end puts the caret at the end of the line the # sits on",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("first line");
    await composer.press("Shift+Enter");
    await composer.pressSequentially("second #");
    await expect(actionList(page)).toBeVisible();
    await page.getByText("Move cursor to line end", { exact: true }).click();
    await expect(composer).toHaveValue("first line\nsecond ");
    await composer.pressSequentially("y");
    await expect(composer).toHaveValue("first line\nsecond y");
    expect(realApp.problems).toEqual([]);
  },
);
