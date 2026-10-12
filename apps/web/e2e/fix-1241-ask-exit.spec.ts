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

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

function errorBanner(page: Page): Locator {
  return page.locator('[data-slot="u1-thread-error"]');
}

/** Ends the omp the app's server started for the chat the way an out-of-memory kill would. */
function killOmp(pids: readonly number[]): void {
  expect(pids).toHaveLength(1);
  for (const pid of pids) process.kill(pid, "SIGKILL");
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

/** Starts a chat, asks the question and waits until omp's question is on screen. */
async function chatWithOpenQuestion(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await sendPrompt(composer, PROMPT);
  await expect(question(page)).toBeVisible({ timeout: 45_000 });
  await expect(question(page)).toContainText("Which database?");
  return composer;
}

/**
 * Issue #1241. omp is killed while its question is open. The question closes by itself, the banner with "Restart omp"
 * is the only thing left, Escape after the kill keeps the real reason, and Restart omp works from the keyboard.
 * Captured in light, dark and at 390 px.
 */
realTest(
  "a question open when omp is killed closes by itself, and Escape after the kill keeps the reason and the restart",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await chatWithOpenQuestion(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1241-question-open-light.png") });

    const killed = realApp.ompProcesses();
    killOmp(killed);

    const banner = errorBanner(page);
    await expect(question(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(banner).toContainText("omp exited (signal SIGKILL)", { timeout: 30_000 });
    await expect(banner.getByRole("button", { name: "Restart omp" })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1241-exited-light.png") });

    // Escape after the kill: there is no question left to answer, so the reason and the restart stay as they are.
    await page.keyboard.press("Escape");
    await expect(banner).toContainText("omp exited (signal SIGKILL)");
    await expect(banner).not.toContainText("No pending extension UI request");
    await expect(banner.getByRole("button", { name: "Restart omp" })).toBeVisible();

    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1241-exited-dark.png") });
    await setTheme(page, false);

    // At this width both side drawers are closed. The capture waits until they have finished moving.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "false");
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await expect(banner.getByRole("button", { name: "Restart omp" })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1241-exited-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    const restart = banner.getByRole("button", { name: "Restart omp" });
    await restart.focus();
    await expect(restart).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(banner).toBeHidden({ timeout: 90_000 });
    const restarted = realApp.ompProcesses();
    expect(restarted).toHaveLength(1);
    expect(restarted).not.toEqual(killed);

    await sendPrompt(composer, "ping after the restart");
    await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 90_000,
    });
    await expect(question(page)).toHaveCount(0);
  },
);

/**
 * Issue #1241, the reload: the question omp was waiting on is not shown again after the page is reloaded, because omp
 * can no longer answer it. The next message starts omp again by itself and is answered.
 */
realTest(
  "after omp is killed with a question open, a reload does not bring the question back, and the next message is answered",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const composer = await chatWithOpenQuestion(page);

    killOmp(realApp.ompProcesses());
    await expect(question(page)).toHaveCount(0, { timeout: 15_000 });

    await page.reload();
    // The chat's open questions are read before its transcript loads, so a stale one would be on screen by then.
    await expect(transcript(page).getByText(PROMPT)).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await expect(question(page)).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, "fix-1241-reload-light.png") });

    await sendPrompt(composer, "ping after the reload");
    await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 90_000,
    });
    await expect(question(page)).toHaveCount(0);
  },
);
