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

/*
 * Issue 1412: a todo reminder is a transcript notice. It was drawn after every message, so it sat below the answer
 * omp gave after it. It is now drawn right after the message it followed, so omp's continuation answer comes after
 * it. The fake model answers the continuation with "pong". Captured in light, dark and at 390 px.
 */

const TODO_PROMPT = "Please make_todos for the release.";
const HEADING = "Unfinished todos (attempt 1 of 3)";
const NOTICES = "Notices in this conversation";
const CONTINUATION = "pong";

/** Lets finite transitions settle before a measurement or a screenshot. Bounded, so a stuck transition cannot hang the case. */
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

/** Whether the reminder's section comes before the element that holds omp's continuation answer, in document order. */
async function reminderComesFirst(page: Page): Promise<boolean> {
  return page.evaluate((answer) => {
    const section = document.querySelector('[data-slot="n1-transcript-notices"]');
    const candidates = Array.from(document.querySelectorAll("p, span, div")).filter(
      (element) => element.children.length === 0 && element.textContent?.trim() === answer,
    );
    const reply = candidates.at(-1);
    if (section === null || reply === undefined) return false;
    return (section.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }, CONTINUATION);
}

realTest(
  "#1412: a todo reminder is drawn right after the answer it followed, above omp's continuation answer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await sendPrompt(composer, TODO_PROMPT);

    const notices = page.getByRole("region", { name: NOTICES });
    await expect(notices.getByText(HEADING)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(CONTINUATION, { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(
      await reminderComesFirst(page),
      "the reminder is drawn above omp's continuation answer, not below it",
    ).toBe(true);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1412-light.png") });

    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1412-dark.png") });

    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(notices.getByText(HEADING)).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1412-390.png") });
    expect(realApp.problems).toEqual([]);
  },
);
