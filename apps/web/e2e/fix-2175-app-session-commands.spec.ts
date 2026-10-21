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
  await expect(page.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });
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

/*
 * Issue 2175, S9b: a typed `/tree`, `/branch` or `/rewind` runs the app's own Conversation history panel instead of the
 * terminal-only note. `/tree` opens the panel on its tree; `/branch` and `/rewind` open it with the rewind sentence, and
 * a turn that is still running keeps `/branch` from rewinding. Words after the name are refused and nothing is sent.
 * Real omp 18.12.2 on the test machine, in the harness's throwaway home: no test touches a real session.
 */

/** The chat the group opens: three exchanges, written the way omp writes them in its session file. */
const base = Date.UTC(2026, 9, 15, 10, 0);
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A message the person sent, and the reply the fake model gave it. */
function exchange(round: string, start: number): Record<string, unknown>[] {
  return [
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: `${round} S9b message` }],
        timestamp: start,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${round} S9b reply` }],
        api: "openai-completions",
        provider: "fake",
        model: "fake-model",
        usage,
        stopReason: "stop",
        timestamp: start + 1_000,
      },
    },
  ];
}

const entries = [
  ...exchange("first", base),
  ...exchange("second", base + 2_000),
  ...exchange("third", base + 4_000),
];

const TREE_HEADER =
  "Browse this chat's messages here. Rewinding opens a new chat and keeps this one.";
const BRANCH_HEADER =
  "Choose one of your messages to rewind to. Your files are not changed, and this chat is kept.";
const BRANCH_RUNNING = "Wait for this chat's turn to finish, then rewind it.";
const TREE_WORDS =
  "/tree doesn't take anything after it, so nothing was sent. Type /tree on its own.";
const BRANCH_WORDS =
  "/branch and /rewind don't take anything after them, so nothing was sent. Type /branch on its own.";

/** The panel's tab in the right sidebar: it is absent while the panel is closed. */
function historyTab(page: Page): Locator {
  return page.getByRole("tab", { name: "Conversation history" });
}

/** The panel's tree of the chat's messages. */
function conversationTree(page: Page): Locator {
  return page.getByRole("tree", { name: "Conversation messages" });
}

/** The header note a command leaves: the status line, filtered to one sentence. */
function headerNote(page: Page, sentence: string): Locator {
  return page.getByRole("status").filter({ hasText: sentence });
}

/** The text colour an element is painted with, as the browser computes it. */
function colourOf(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).color);
}

/** The element's box lies inside a screen `width` pixels wide. */
async function expectInsideWidth(locator: Locator, width: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
}

/** Opens the seeded chat from the session list, as the W6 spec does, and returns its message box. */
async function openSeededChat(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  await expect(page.getByText("third S9b message", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  return page.getByRole("textbox", { name: "Message input" });
}

/** Focus is inside the tree: on the tree itself, or on one of its rows. */
async function expectFocusInTree(page: Page): Promise<void> {
  const tree = conversationTree(page);
  await expect
    .poll(() => tree.evaluate((element) => element.contains(document.activeElement)), {
      timeout: 30_000,
    })
    .toBe(true);
}

/** Types `/br`, then shoots the /branch row of the slash list in the page's theme. */
async function shootBranchRow(page: Page, composer: Locator, file: string): Promise<void> {
  await composer.fill("/br");
  const row = listRow(page, /^\/branch/);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("Rewind this chat to one of your messages. This chat is kept.");
  // The row is painted with the app's own colour, not the browser's default black.
  expect(await colourOf(row)).not.toBe("rgb(0, 0, 0)");
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, file), fullPage: true });
}

/** Chooses the /branch row, then shoots the open panel with its rewind header in the page's theme. */
async function shootBranchPanel(page: Page, composer: Locator, file: string): Promise<void> {
  await chooseRow(page, composer, "/branch", /^\/branch/);
  const note = headerNote(page, BRANCH_HEADER);
  await expect(note).toBeVisible({ timeout: 30_000 });
  // The header sentence is painted with the app's own colour, not the browser's default black.
  expect(await colourOf(note)).not.toBe("rgb(0, 0, 0)");
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, file), fullPage: true });
}

realTest.describe("S9b: /tree, /branch and /rewind open the Conversation history panel", () => {
  realTest.use({ seedEntries: { entries } });

  realTest(
    "S9b: a typed /tree picks its row, which opens the panel on its tree with the /tree header; Escape returns to the message box",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      const composer = await openSeededChat(page);

      // `/tree` lists its own row, which says what it does; Enter on that row opens the panel.
      await composer.fill("/tree");
      const row = listRow(page, /^\/tree/);
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row).toContainText("Browse this chat's messages, to rewind or fork from one");
      await composer.press("Enter");

      await expect(headerNote(page, TREE_HEADER)).toBeVisible({ timeout: 30_000 });
      await expect(historyTab(page)).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      await expect(conversationTree(page)).toBeVisible({ timeout: 30_000 });
      await expectFocusInTree(page);
      await expect(composer).toHaveValue("");

      // Escape gives the focus back to the message box.
      await page.keyboard.press("Escape");
      await expect(composer).toBeFocused();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "S9b: words after /tree or /branch are refused under the message box, nothing opens, and the text stays",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      const composer = await openSeededChat(page);

      const refused = [
        { typed: "/tree now", sentence: TREE_WORDS },
        { typed: "/branch now", sentence: BRANCH_WORDS },
        { typed: "/rewind now", sentence: BRANCH_WORDS },
      ];
      for (const { typed, sentence } of refused) {
        await composer.fill(typed);
        await composer.press("Enter");
        await expect(
          page.locator('[data-composer-error="true"]').filter({ hasText: sentence }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(composer).toHaveValue(typed);
        await expect(historyTab(page)).toHaveCount(0);
      }
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "S9b: /rewind and /bran pick the /branch row, which opens the panel with the rewind header",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      const composer = await openSeededChat(page);

      // `/rewind` is an alias: its list shows the /branch row, and Enter on that row opens the panel.
      await chooseRow(page, composer, "/rewind", /^\/branch/);
      await expect(headerNote(page, BRANCH_HEADER)).toBeVisible({ timeout: 30_000 });
      await expect(historyTab(page)).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      await expect(conversationTree(page)).toBeVisible({ timeout: 30_000 });

      await page.keyboard.press("Escape");
      await chooseRow(page, composer, "/bran", /^\/branch/);
      await expect(headerNote(page, BRANCH_HEADER)).toBeVisible({ timeout: 30_000 });
      await expect(historyTab(page)).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "S9b: while a reply runs, /branch says to wait and does not open the panel, and /tree still opens it",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      const composer = await openSeededChat(page);
      const stop = page.getByRole("button", { name: "Stop generating" });

      // `stream_held` keeps the reply open until the spec writes release-held-reply (see
      // fake-openai-server.ts and fix-1302-running-chat.spec.ts): the chat is busy from here.
      await sendPrompt(composer, "stream_held S9b");
      await expect(stop).toBeVisible({ timeout: 120_000 });

      await chooseRow(page, composer, "/branch", /^\/branch/);
      await expect(headerNote(page, BRANCH_RUNNING)).toBeVisible({ timeout: 30_000 });
      await expect(historyTab(page)).toHaveCount(0);

      await chooseRow(page, composer, "/tree", /^\/tree/);
      await expect(headerNote(page, TREE_HEADER)).toBeVisible({ timeout: 30_000 });
      await expect(historyTab(page)).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      await expect(conversationTree(page)).toBeVisible({ timeout: 30_000 });

      await writeFile(join(realApp.agentDir, "release-held-reply"), "");
      await expect(stop).toHaveCount(0, { timeout: 120_000 });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "S9b: the /branch row and its panel read in light mode at 1280 px",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      await mkdir(screenshots, { recursive: true });
      const page = await realApp.open();
      const composer = await openSeededChat(page);
      await shootBranchRow(page, composer, "fix-2175-s9b-list-light-1280.png");
      await shootBranchPanel(page, composer, "fix-2175-s9b-panel-light-1280.png");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "S9b: the /branch row and its panel read in dark mode at 1280 px",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      await mkdir(screenshots, { recursive: true });
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
      });
      await expect(page.locator("html")).toHaveClass(/dark/);
      const composer = await openSeededChat(page);
      await shootBranchRow(page, composer, "fix-2175-s9b-list-dark-1280.png");
      await shootBranchPanel(page, composer, "fix-2175-s9b-panel-dark-1280.png");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "S9b: the rewind panel and its header sentence fit a 390 px screen",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      await mkdir(screenshots, { recursive: true });
      const page = await realApp.open();
      const composer = await openSeededChat(page);
      await page.setViewportSize({ width: 390, height: 844 });

      await chooseRow(page, composer, "/branch", /^\/branch/);
      const note = headerNote(page, BRANCH_HEADER);
      await expect(note).toBeVisible({ timeout: 30_000 });
      await expect(conversationTree(page)).toBeVisible({ timeout: 30_000 });
      await waitForFiniteAnimations(page);
      await expectInsideWidth(page.locator('[data-shell-sidebar="right"]'), 390);
      await expectInsideWidth(note, 390);
      expect(await colourOf(note)).not.toBe("rgb(0, 0, 0)");
      await page.screenshot({
        path: join(screenshots, "fix-2175-s9b-panel-light-390.png"),
        fullPage: true,
      });
      expect(realApp.problems).toEqual([]);
    },
  );
});
