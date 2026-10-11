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

/**
 * omp's question dialog is named by its question, not by its kind (#850). The fake model answers a
 * prompt containing "ask_user" with a select request titled "Which database?"; the dialog's accessible
 * name must be that question. Captured in light, dark and at 390 px.
 */

const QUESTION = /Which database\?/;

/** Lets finite transitions settle before a screenshot. Bounded, so a transition that never ends cannot hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

realTest(
  "#850: omp's question dialog is named by its question, in light, dark and at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "Please ask_user which database to use.");

    const question = page.getByRole("dialog", { name: QUESTION });
    await expect(question).toBeVisible({ timeout: 45_000 });
    await expect(question).toContainText("Which database?");
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-850-ask-light.png") });

    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-850-ask-dark.png") });

    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(question).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-850-ask-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
