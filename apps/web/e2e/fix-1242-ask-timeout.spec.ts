import { mkdir, writeFile } from "node:fs/promises";
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

/**
 * Issue #1242. With Ask Timeout on (omp's `ask.timeout`, here 15 seconds), omp answers an unanswered question with its
 * recommended option when the time runs out. The question dialog says how long is left and what omp will answer then;
 * the answer omp receives must be the one the dialog named.
 */

realTest.setTimeout(300_000);

const QUESTION = /^Answer questions$/;
const TIME_LEFT = /^Time left: \d+ seconds?\.$/;
const WHAT_OMP_ANSWERS = /When time runs out, omp uses its recommended answer for each question/;

function question(page: Page): Locator {
  return page.getByRole("dialog", { name: QUESTION });
}

function timer(page: Page): Locator {
  return page.getByRole("timer");
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/** Turns Ask Timeout on for the run: omp reads its settings from the agent folder when a chat's omp starts. */
async function turnOnAskTimeout(agentDir: string): Promise<void> {
  await writeFile(join(agentDir, "config.yml"), "ask:\n  timeout: 15\n");
}

/** Asks omp one question in a new chat and waits until the question is on screen with its countdown. */
async function askAndWaitForCountdown(page: Page, prompt: string): Promise<Locator> {
  const composer = await startChat(page);
  await sendPrompt(composer, prompt);
  await expect(question(page)).toBeVisible({ timeout: 45_000 });
  await expect(timer(page)).toHaveText(TIME_LEFT);
  await expect(question(page).getByText(WHAT_OMP_ANSWERS)).toBeVisible();
  return composer;
}

/** The screen shows no failure: no error banner, no "omp update unavailable" notice, no "could not" reason. */
async function expectNoFailure(page: Page): Promise<void> {
  await expect(page.locator('[data-slot="u1-thread-error"]')).toHaveCount(0);
  await expect(page.getByText("omp update unavailable")).toHaveCount(0);
  await expect(page.getByText(/No pending extension UI request|could not continue/)).toHaveCount(0);
}

realTest(
  "with Ask Timeout on, the question counts down and omp answers with the recommended option when time runs out",
  async ({ realApp }) => {
    await turnOnAskTimeout(realApp.agentDir);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await askAndWaitForCountdown(page, "Please ask_recommended which database to use.");
    await expect(question(page)).toContainText("Which database?");

    // The countdown moves while the person reads the question.
    const first = await timer(page).textContent();
    await expect.poll(async () => timer(page).textContent(), { timeout: 5_000 }).not.toBe(first);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1242-countdown-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1242-countdown-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1242-countdown-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Nothing is answered: the time runs out, the dialog closes, and omp's answer is the recommended option.
    await expect(question(page)).toHaveCount(0, { timeout: 45_000 });
    await expect(
      transcript(page).getByText(/tool said:.*SQLite \(auto-selected after timeout\)/),
    ).toBeVisible({ timeout: 60_000 });
    await expectNoFailure(page);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "with Ask Timeout on and no recommended option, omp answers with the first option when time runs out",
  async ({ realApp }) => {
    await turnOnAskTimeout(realApp.agentDir);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await askAndWaitForCountdown(page, "Please ask_user which database to use.");

    await expect(question(page)).toHaveCount(0, { timeout: 45_000 });
    await expect(
      transcript(page).getByText(/tool said:.*Postgres \(auto-selected after timeout\)/),
    ).toBeVisible({ timeout: 60_000 });
    await expectNoFailure(page);
    expect(realApp.problems).toEqual([]);
  },
);
