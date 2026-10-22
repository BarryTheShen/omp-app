import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  type RealApp,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/*
 * Issue 2175, S9d: a typed `/clear` runs the app's own version. omp clears a chat in place in its terminal, and RPC has no
 * way to, so the app starts a new chat in the same folder and says so in it. The old chat stays in the list. A reply still
 * being written makes `/clear` wait, and words after the name are refused. Real omp 18.12.2 on the test machine, in the harness's
 * throwaway home: no test touches a real session.
 */

// omp 18.12.2 is at this path in every the test machine job.
realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });
realTest.setTimeout(300_000);

const NOTE =
  "This is a new chat. omp can only clear a chat in place in its terminal, so /clear started a new one here. Your previous chat is still in your list.";
const WAIT = "Wait for this chat's turn to finish, then clear it.";
const WORDS = "/clear doesn't take anything after it, so nothing was sent. Type /clear on its own.";

/** The session files on disk, anywhere under omp's sessions folder. No folder yet means no session. */
async function sessionFiles(realApp: RealApp): Promise<string[]> {
  try {
    const names = await readdir(join(realApp.agentDir, "sessions"), { recursive: true });
    return names.map(String).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** The rows of the session list. */
function sessionRows(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" }).getByRole("option");
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

/** Types `/cl`, waits for the `/` list to offer `/clear` first, and presses Enter: the pick the pin pins. */
async function typeClear(page: Page, composer: Locator): Promise<void> {
  await composer.fill("/cl");
  await expect(
    page
      .getByRole("listbox", { name: "Slash commands" })
      .getByRole("option", { name: /^\/clear / }),
  ).toBeVisible();
  await composer.press("Enter");
}

realTest(
  "real omp: /cl starts a new chat in the same folder, says so in it, and keeps the old chat in the list",
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
    const before = await sessionFiles(realApp);
    expect(before).toHaveLength(1);

    await typeClear(page, composer);
    const messages = page.getByRole("region", { name: "Messages" });
    await expect(page.getByText(NOTE)).toBeVisible({ timeout: 60_000 });
    await expect(messages.getByText("pong", { exact: true })).toHaveCount(0);
    // The old chat stays in the list. An empty chat is not listed until it has a message, as the chat `/new` opens is not.
    await expect(sessionRows(page)).toHaveCount(1, { timeout: 60_000 });
    expect(await sessionFiles(realApp)).toEqual(expect.arrayContaining(before));
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("");

    // The note is drawn: its colour is set by the page's styles, not left to the browser's default.
    const note = page.getByText(NOTE);
    expect(await note.evaluate((element) => getComputedStyle(element).color)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2175-clear-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-2175-clear-dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      "the new chat with its note must fit the 390 px viewport",
    ).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(screenshots, "fix-2175-clear-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    // The new chat takes a message: it is a new session in the same folder, and the old chat stays in the list.
    await sendPrompt(composer, "ping");
    await expect(messages.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 120_000 });
    await expect(sessionRows(page)).toHaveCount(2, { timeout: 60_000 });
    expect((await sessionFiles(realApp)).length).toBe(2);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: /cl while a reply is still being written says to wait, and starts nothing",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    // The fake model streams the first lines of this reply, then holds it until the spec releases it.
    await sendPrompt(composer, "stream_held: hold the reply open");
    await expect(page.getByText("Here is the long streamed block:")).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
    const rows = await sessionRows(page).count();

    await typeClear(page, composer);
    await expect(page.getByText(WAIT)).toBeVisible();
    await expect(page.getByText(NOTE)).toHaveCount(0);
    expect(await sessionRows(page).count()).toBe(rows);
    await expect(page.getByText("Here is the long streamed block:")).toBeVisible();

    await writeFile(join(realApp.agentDir, "release-held-reply"), "");
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
      timeout: 120_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: /clear with words after it is refused with the sentence, and the text stays",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "ping");
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    const rows = await sessionRows(page).count();

    await composer.fill("/clear now");
    await composer.press("Enter");
    await expect(page.getByText(WORDS)).toBeVisible();
    await expect(composer).toHaveValue("/clear now");
    expect(await sessionRows(page).count()).toBe(rows);
    await expect(page.getByText(NOTE)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
