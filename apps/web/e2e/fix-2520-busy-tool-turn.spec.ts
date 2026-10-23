/// <reference types="node" />
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  narrowTo,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

// Issue 2520: while a turn runs a tool, /clear, /fork and /branch say to wait and start nothing.
// On the fake model, `intent_probe N` runs one bash step of N seconds. The commands are sent while that step runs,
// and the screenshots are taken then.
const STEP_SECONDS = 90;
const STEP_PROMPT = `intent_probe ${STEP_SECONDS}`;
const WAIT = {
  clear: "Wait for this chat's turn to finish, then clear it.",
  fork: "Wait for this chat's turn to finish, then fork it.",
  branch: "Wait for this chat's turn to finish, then rewind it.",
} as const;
// What each command shows when it runs. None of these may appear while the step runs.
const DONE = {
  clear: "This is a new chat. omp can only clear a chat in place",
  fork: "Forked. You are now in the copy of your chat.",
  branch: "Choose one of your messages to rewind to",
} as const;

function stopButton(page: Page): Locator {
  return page.getByRole("button", { name: "Stop generating" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/** The header note that carries a command's sentence, read the way the other command specs read it. */
function headerNote(page: Page, sentence: string): Locator {
  return page.getByRole("status").filter({ hasText: sentence });
}

/** The note is painted with the popover text token in the current theme, as the computed style shows. */
async function expectNoticeToken(note: Locator): Promise<void> {
  const colors = await note.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.color = "var(--popover-foreground)";
    document.body.append(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(element).color, token };
  });
  expect(colors.token).not.toBe("rgb(0, 0, 0)");
  expect(colors.actual).toBe(colors.token);
}

/** Types a command, waits for its row in the `/` list as a person would, and presses Enter. */
async function runCommand(
  page: Page,
  composer: Locator,
  typed: string,
  row: RegExp,
): Promise<void> {
  await composer.fill(typed);
  await expect(
    page.getByRole("listbox", { name: "Slash commands" }).getByRole("option", { name: row }),
  ).toBeVisible();
  await composer.press("Enter");
}

/** Sends /clear, /fork and /branch while the step runs. Each says to wait, and nothing starts. */
async function sendCommandsWhileRunning(page: Page, composer: Locator): Promise<void> {
  await runCommand(page, composer, "/clear", /^\/clear /);
  await expect(headerNote(page, WAIT.clear)).toBeVisible();
  await expect(page.getByText(DONE.clear)).toHaveCount(0);

  await runCommand(page, composer, "/fo", /^\/fork /);
  await expect(headerNote(page, WAIT.fork)).toBeVisible();
  await expect(page.getByText(DONE.fork)).toHaveCount(0);

  await runCommand(page, composer, "/branch", /^\/branch /);
  await expect(headerNote(page, WAIT.branch)).toBeVisible();
  await expect(page.getByText(DONE.branch)).toHaveCount(0);

  // The same chat is still open, with the step's prompt in it, and the step is still running.
  await expect(transcript(page).getByText(STEP_PROMPT)).toBeVisible();
  await expect(stopButton(page)).toBeVisible();
}

/** Starts the bash step. Returns once its card is running. */
async function startStep(page: Page, composer: Locator): Promise<void> {
  await sendPrompt(composer, STEP_PROMPT);
  await expect(page.getByTestId("u3-bash-card").last()).toContainText("Running", {
    timeout: 90_000,
  });
  await expect(stopButton(page)).toBeVisible();
}

/** Screenshots the state during the bash step: the step's card is running, and the /branch note is the last one on screen. */
async function capture(page: Page, name: string): Promise<void> {
  await expect(stopButton(page)).toBeVisible();
  await expect(page.getByTestId("u3-bash-card").last()).toContainText("Running");
  await expectNoticeToken(headerNote(page, WAIT.branch));
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

/** Lets the step finish: the stop button goes, and the prompt is still in the same chat. */
async function finishStep(page: Page): Promise<void> {
  await expect(stopButton(page)).toHaveCount(0, { timeout: 180_000 });
  await expect(transcript(page).getByText(STEP_PROMPT)).toBeVisible();
}

realTest.setTimeout(300_000);

realTest(
  "#2520: during a bash step, /clear, /fork and /branch say to wait and start nothing, in light at 1280 px",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await startStep(page, composer);
    await sendCommandsWhileRunning(page, composer);
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await capture(page, "fix-2520-busy-light.png");
    await finishStep(page);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#2520: during a bash step, /clear, /fork and /branch say to wait and start nothing, in dark at 1280 px",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    const composer = await startChat(page);
    await startStep(page, composer);
    await sendCommandsWhileRunning(page, composer);
    await capture(page, "fix-2520-busy-dark.png");
    await finishStep(page);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#2520: during a bash step, /clear, /fork and /branch say to wait and start nothing, at 390 px",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await startStep(page, composer);
    await narrowTo(page);
    await sendCommandsWhileRunning(page, composer);
    await capture(page, "fix-2520-busy-390.png");
    await finishStep(page);
    expect(realApp.problems).toEqual([]);
  },
);
