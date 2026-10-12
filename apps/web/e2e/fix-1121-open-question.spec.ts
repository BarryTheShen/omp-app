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

realTest.setTimeout(300_000);

/** The fake model asks omp's question (Which database? Postgres, SQLite) for a prompt that asks for ask_user. */
const PROMPT = "Please ask_user which database to use.";
const QUESTION = /^Answer questions$/;

function question(page: Page): Locator {
  return page.getByRole("dialog", { name: QUESTION });
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

/** Answers the question with SQLite and waits until omp has taken the answer. */
async function answerWithSqlite(page: Page): Promise<void> {
  await question(page)
    .getByRole("radio", { name: /^SQLite/ })
    .click();
  await question(page).getByRole("button", { name: "Review", exact: true }).click();
  await question(page).getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByText(/tool said:/)).toBeVisible({ timeout: 45_000 });
}

/**
 * Issue #1121. omp asks a question, and the page is reloaded before anyone answers it. The question is shown again, and
 * answering it continues the turn. Captured after the reload in light, dark and at 390 px.
 */
realTest(
  "a question omp is still waiting on is shown again after a reload, and the answer continues the turn",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    await expect(question(page)).toBeVisible({ timeout: 45_000 });

    await page.reload();
    await expect(question(page)).toBeVisible({ timeout: 60_000 });
    await expect(question(page)).toContainText("Which database?");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1121-reload-light.png") });

    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1121-reload-dark.png") });

    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(question(page)).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1121-reload-narrow.png") });

    await page.setViewportSize({ width: 1280, height: 800 });
    await answerWithSqlite(page);
    await expect(question(page)).toHaveCount(0);
    await expect(page.getByText(/Conversation settled/).first()).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);

/**
 * Issue #1121, the reopen: a second tab on a chat omp is waiting on shows the question too, and answering it there
 * continues the turn. The second tab is opened from the first with `window.open`, as in the #762 spec.
 */
realTest(
  "a second tab on a chat omp is waiting on shows the question, and the answer there continues the turn",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const first = await realApp.open();
    const composer = await startChat(first);
    await sendPrompt(composer, PROMPT);
    await expect(question(first)).toBeVisible({ timeout: 45_000 });

    const launch = `${new URL(first.url()).origin}/#token=${encodeURIComponent(realApp.token)}`;
    const popup = first.waitForEvent("popup");
    await first.evaluate((url) => {
      window.open(url, "_blank");
    }, launch);
    const second = await popup;

    await expect(question(second)).toBeVisible({ timeout: 60_000 });
    await answerWithSqlite(second);
    await expect(second.getByText(/Conversation settled/).first()).toBeVisible({ timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);
