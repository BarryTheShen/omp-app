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

declare global {
  interface Window {
    __keyLog?: { key: string; defaultPrevented: boolean }[];
  }
}

/**
 * Logs every keydown on the window, which runs after the app's handlers: `defaultPrevented` shows whether a
 * handler took the key. A key left alone (not prevented) is the one the browser acts on, such as Alt+Left = Back.
 * Headless Chromium does not run the browser's own Back shortcut for a synthetic key press, so this check is about
 * the page's event, not about a navigation.
 */
async function recordKeydowns(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: { key: string; defaultPrevented: boolean }[] = [];
    window.__keyLog = log;
    window.addEventListener("keydown", (event) => {
      // Playwright also sends the modifier's own keydown; only the key pressed with it is of interest.
      if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) return;
      log.push({ key: event.key, defaultPrevented: event.defaultPrevented });
    });
  });
}

function takeKeydowns(page: Page): Promise<{ key: string; defaultPrevented: boolean }[]> {
  return page.evaluate(() => (window.__keyLog ?? []).splice(0));
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

realTest(
  "#970: Alt, Ctrl, Meta and Shift arrow keys are left to the browser in the panel tabs and the chat list",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    // The chat joins the Session list once it has a message, so one prompt is sent and its reply awaited.
    await sendPrompt(composer, "hello");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 120_000 });
    await recordKeydowns(page);

    // The panel tabs: a modified arrow, Home or End is not taken by the tab row.
    const todo = page.getByRole("tab", { name: "Todo checklist" });
    await todo.focus();
    for (const combination of [
      "Alt+ArrowRight",
      "Alt+ArrowLeft",
      "Shift+ArrowRight",
      "Control+End",
      "Meta+ArrowRight",
    ]) {
      await page.keyboard.press(combination);
    }
    const modified = await takeKeydowns(page);
    expect(modified.map((event) => event.key)).toEqual([
      "ArrowRight",
      "ArrowLeft",
      "ArrowRight",
      "End",
      "ArrowRight",
    ]);
    expect(modified.filter((event) => event.defaultPrevented)).toEqual([]);
    await expect(todo).toBeFocused();
    await expect(todo).toHaveAttribute("aria-selected", "true");

    // A plain arrow still moves along the tabs: the tab row takes it.
    await page.keyboard.press("ArrowRight");
    expect(await takeKeydowns(page)).toEqual([{ key: "ArrowRight", defaultPrevented: true }]);
    await expect(page.getByRole("tab").nth(1)).toBeFocused();

    // The chat list: Alt+ArrowDown is left alone; a plain ArrowDown is still taken by the list.
    const row = page.getByRole("listbox", { name: "Session list" }).getByRole("option").first();
    await row.focus();
    await page.keyboard.press("Alt+ArrowDown");
    expect(await takeKeydowns(page)).toEqual([{ key: "ArrowDown", defaultPrevented: false }]);
    await page.keyboard.press("ArrowDown");
    expect(await takeKeydowns(page)).toEqual([{ key: "ArrowDown", defaultPrevented: true }]);

    // Captures of the panel tabs in light, dark and 390 px.
    await page.getByRole("tab", { name: "Todo checklist" }).focus();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-970-tabs-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-970-tabs-dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-970-tabs-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
