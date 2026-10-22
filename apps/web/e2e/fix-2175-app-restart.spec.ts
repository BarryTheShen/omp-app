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

/*
 * Issue 2284, S9e: `/restart` asks first, then restarts omp on this chat. `/res` picks it. Cancel and Escape send nothing.
 * Restart omp starts a new omp on the saved chat, which keeps its messages. A reply still being written is named in the
 * question, and Restart ends it. Real omp 18.12.2 on the test machine.
 */

// omp 18.12.2 is at this path in every the test machine job.
realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });
realTest.setTimeout(300_000);

const TITLE = "Restart omp for this chat?";
const IDLE_TEXT =
  "omp stops and starts again on this chat's saved messages. Background work omp started for this chat may stop too.";
const RUNNING_TEXT =
  "A reply is still being written, and it will stop. omp then starts again on this chat's saved messages. Background work omp started for this chat may stop too.";
const DONE = "omp restarted. This chat is where you left it.";
const WORDS_REFUSAL =
  "/restart doesn't take anything after it, so nothing was sent. Type /restart on its own.";

function restartDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Restart omp", exact: true });
}

function banner(page: Page): Locator {
  return page.locator('[data-slot="u1-thread-error"]');
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

/** The colour the destructive token resolves to, read the way the page paints it. */
async function destructiveColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const token = document.createElement("span");
    token.style.color = "var(--destructive)";
    document.body.append(token);
    const color = getComputedStyle(token).color;
    token.remove();
    return color;
  });
}

/** Types `/res`, waits for the `/` list to offer `/restart` first, and presses Enter: the pick the pin pins. */
async function typeRestart(page: Page, composer: Locator): Promise<void> {
  await composer.fill("/res");
  await expect(
    page
      .getByRole("listbox", { name: "Slash commands" })
      .getByRole("option", { name: /^\/restart / }),
  ).toBeVisible();
  await composer.press("Enter");
}

/**
 * The question's words and styles are checked before any capture: the dialog is painted, and the destructive button's
 * text has the destructive colour. Then it is captured in light, dark, and at 390 px wide, where it must fit.
 */
async function captureQuestion(page: Page, name: string, words: string): Promise<void> {
  const dialog = restartDialog(page);
  await expect(dialog).toContainText(TITLE);
  await expect(dialog).toContainText(words);
  const painted = await dialog.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(painted, `${name} dialog is painted`).not.toBe("rgba(0, 0, 0, 0)");
  const confirm = dialog.getByRole("button", { name: "Restart omp", exact: true });
  const confirmColor = await confirm.evaluate((element) => getComputedStyle(element).color);
  expect(confirmColor, `${name} confirm text is destructive`).toBe(await destructiveColor(page));

  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, `fix-2175-restart-${name}-light.png`) });
  await setTheme(page, true);
  await page.screenshot({ path: join(screenshots, `fix-2175-restart-${name}-dark.png`) });
  await setTheme(page, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForFiniteAnimations(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    `${name} must fit the 390 px viewport`,
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(screenshots, `fix-2175-restart-${name}-narrow.png`) });
  await page.setViewportSize({ width: 1280, height: 800 });
}

realTest(
  "real omp: /res asks first; Cancel and Escape send nothing; Restart omp starts omp again on this chat",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => realApp.ompProcesses()).toHaveLength(1);
    const before = realApp.ompProcesses();

    await typeRestart(page, composer);
    const dialog = restartDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await captureQuestion(page, "idle", IDLE_TEXT);

    // Escape closes the question, and omp is the same process.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(realApp.ompProcesses()).toEqual(before);

    // Restart omp: a new omp starts on this chat, and the chat keeps its messages.
    await typeRestart(page, composer);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Restart omp", exact: true }).click();
    await expect
      .poll(() => realApp.ompProcesses().filter((pid) => !before.includes(pid)), {
        timeout: 90_000,
      })
      .toHaveLength(1);
    await expect.poll(() => realApp.ompProcesses()).toHaveLength(1);
    await expect(page.getByText(DONE)).toBeVisible({ timeout: 60_000 });
    const messages = page.getByRole("region", { name: "Messages" });
    await expect(messages.getByText("ping", { exact: true })).toBeVisible();
    await expect(messages.getByText("pong", { exact: true })).toBeVisible();
    await expect(banner(page)).toHaveCount(0, { timeout: 60_000 });

    // The chat takes a new message on the new omp.
    await sendPrompt(composer, "ping");
    await expect(messages.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 120_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: a reply still being written is named in the question, and Restart omp ends it",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    // The first turn is saved, so a restart can continue this chat. The fake model streams the first lines of the second
    // reply, then holds it until the spec releases it.
    await sendPrompt(composer, "stream_held: hold the reply open");
    await expect(page.getByText("Here is the long streamed block:")).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
    await expect.poll(() => realApp.ompProcesses()).toHaveLength(1);
    const before = realApp.ompProcesses();

    await typeRestart(page, composer);
    const dialog = restartDialog(page);
    await expect(dialog).toBeVisible();
    await captureQuestion(page, "running", RUNNING_TEXT);

    await dialog.getByRole("button", { name: "Restart omp", exact: true }).click();
    await expect
      .poll(() => realApp.ompProcesses().filter((pid) => !before.includes(pid)), {
        timeout: 90_000,
      })
      .toHaveLength(1);
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(page.getByText(DONE)).toBeVisible({ timeout: 60_000 });

    // The chat takes a new message after the restart.
    await sendPrompt(composer, "ping");
    const messages = page.getByRole("region", { name: "Messages" });
    await expect(messages.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 120_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: /restart with words after it is refused with the sentence, and no question opens",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    const before = realApp.ompProcesses();
    await composer.fill("/restart now");
    await composer.press("Enter");
    await expect(page.getByText(WORDS_REFUSAL)).toBeVisible();
    await expect(composer).toHaveValue("/restart now");
    await expect(restartDialog(page)).toHaveCount(0);
    expect(realApp.ompProcesses()).toEqual(before);
    expect(realApp.problems).toEqual([]);
  },
);
