import { mkdir, readdir } from "node:fs/promises";
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
 * Issue 2175, S9a: a typed `/delete` runs the app's own version. It asks with the chat's own delete question, the same
 * one `/session delete` asks, and Delete runs the same flow. Words after the name are refused and nothing is sent.
 * Real omp 18.12.2 on the test machine, in the harness's throwaway home: no test touches a real session.
 */

// omp 18.12.2 is at this path in every the test machine job.
realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });

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

/** The chat's row in the session list: an option whose name starts with its title. */
function chatRow(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(`^${title}`) });
}

/** The row of the slash list whose name matches. */
function listRow(page: Page, name: RegExp): Locator {
  return page.getByRole("listbox", { name: "Slash commands" }).getByRole("option", { name });
}

/** The question `/delete` asks first: the chat's own delete question, whose accessible name is "Delete chat". */
function deleteQuestion(page: Page): Locator {
  return page.getByRole("dialog", { name: "Delete chat" });
}

/** The refusal under the message box for words typed after `/delete`. */
function wordsRefusal(page: Page): Locator {
  return page
    .locator('[data-composer-error="true"]')
    .filter({ hasText: "/delete doesn't take anything after it, so nothing was sent." });
}

/** A chat that has answered "ping" with "pong": one session file, one row, and its composer. */
async function chatWithPingPong(
  page: Page,
  realApp: RealApp,
): Promise<{ readonly composer: Locator; readonly chatFile: string }> {
  const composer = await startChat(page);
  await sendPrompt(composer, "ping");
  await expect(page.getByText("pong", { exact: true })).toHaveCount(1);
  await expect.poll(() => sessionFiles(realApp), { timeout: 30_000 }).toHaveLength(1);
  const [chatFile] = await sessionFiles(realApp);
  if (chatFile === undefined) throw new Error("the chat has no session file");
  await expect(chatRow(page, "ping")).toBeVisible({ timeout: 30_000 });
  return { composer, chatFile };
}

/** Types `typed`, waits until the slash list shows the row `label`, then presses Enter, which chooses that row. */
async function chooseRow(
  page: Page,
  composer: Locator,
  typed: string,
  label: RegExp,
): Promise<void> {
  await composer.fill(typed);
  await expect(listRow(page, label)).toBeVisible({ timeout: 60_000 });
  await composer.press("Enter");
}

realTest(
  "S9a: a typed /del picks the /delete row, which asks with the chat's delete question; Cancel and Escape keep the chat, and Delete removes it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const { composer, chatFile } = await chatWithPingPong(page, realApp);

    // `/del` lists the app's own row first (it was `/model` before S9a); Enter on it opens the question.
    await composer.fill("/del");
    const row = listRow(page, /^\/delete/);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText("Delete this chat, after you confirm");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9a-row-light-1280.png"),
      fullPage: true,
    });
    await composer.press("Enter");

    const question = deleteQuestion(page);
    await expect(question).toBeVisible({ timeout: 30_000 });
    await expect(question).toContainText('Delete "ping"?');
    await expect(question).toContainText("Deleting this chat cannot be undone.");
    await expect(question.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9a-dialog-light-1280.png"),
      fullPage: true,
    });

    // Escape cancels: the chat's file stays, and the message box is empty and focused.
    await page.keyboard.press("Escape");
    await expect(question).toBeHidden();
    await expect(composer).toHaveValue("");
    await expect(composer).toBeFocused();
    expect(await sessionFiles(realApp)).toContain(chatFile);

    // Words after the name are refused under the message box: no question opens and the text stays.
    await composer.fill("/delete now");
    await composer.press("Enter");
    await expect(wordsRefusal(page)).toBeVisible({ timeout: 30_000 });
    await expect(composer).toHaveValue("/delete now");
    await expect(question).toBeHidden();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9a-words-light-1280.png"),
      fullPage: true,
    });

    // `/delete` + Enter asks again; Delete removes the chat's file, a new chat takes its place, and the row goes.
    await chooseRow(page, composer, "/delete", /^\/delete/);
    await expect(question).toBeVisible({ timeout: 30_000 });
    await question.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => sessionFiles(realApp), { timeout: 30_000 }).not.toContain(chatFile);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await expect(chatRow(page, "ping")).toHaveCount(0, { timeout: 30_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "S9a: the /delete row and its question read in dark mode",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const { composer, chatFile } = await chatWithPingPong(page, realApp);

    await composer.fill("/del");
    const row = listRow(page, /^\/delete/);
    await expect(row).toBeVisible({ timeout: 60_000 });
    // The row is painted with the app's own colour, not the browser's default text colour.
    expect(await row.evaluate((element) => getComputedStyle(element).color)).not.toBe(
      "rgb(0, 0, 0)",
    );
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9a-row-dark-1280.png"),
      fullPage: true,
    });
    await composer.press("Enter");

    const question = deleteQuestion(page);
    await expect(question).toBeVisible({ timeout: 30_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9a-dialog-dark-1280.png"),
      fullPage: true,
    });
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toBeHidden();
    await composer.fill("/delete now");
    await composer.press("Enter");
    await expect(wordsRefusal(page)).toBeVisible({ timeout: 30_000 });
    // The refusal is painted with the app's own colour, not the browser's default text colour.
    expect(
      await wordsRefusal(page).evaluate((element) => getComputedStyle(element).color),
    ).not.toBe("rgb(0, 0, 0)");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9a-words-dark-1280.png"),
      fullPage: true,
    });
    expect(await sessionFiles(realApp)).toContain(chatFile);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "S9a: the /delete row, its question and its refusal fit a 390 px screen",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const { composer, chatFile } = await chatWithPingPong(page, realApp);
    await page.setViewportSize({ width: 390, height: 844 });

    await composer.fill("/del");
    const row = listRow(page, /^\/delete/);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    const rowBox = await row.boundingBox();
    expect(rowBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9a-row-light-390.png"),
      fullPage: true,
    });
    await composer.press("Enter");

    const question = deleteQuestion(page);
    await expect(question).toBeVisible({ timeout: 30_000 });
    await waitForFiniteAnimations(page);
    const questionBox = await question.boundingBox();
    expect(questionBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((questionBox?.x ?? 0) + (questionBox?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9a-dialog-light-390.png"),
      fullPage: true,
    });
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toBeHidden();

    await composer.fill("/delete now");
    await composer.press("Enter");
    await expect(wordsRefusal(page)).toBeVisible({ timeout: 30_000 });
    await waitForFiniteAnimations(page);
    const refusalBox = await wordsRefusal(page).boundingBox();
    expect(refusalBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((refusalBox?.x ?? 0) + (refusalBox?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9a-words-light-390.png"),
      fullPage: true,
    });
    expect(await sessionFiles(realApp)).toContain(chatFile);
    expect(realApp.problems).toEqual([]);
  },
);
