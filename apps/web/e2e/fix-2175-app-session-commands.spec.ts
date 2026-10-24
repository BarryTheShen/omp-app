import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  "S9a: a typed /delete picks the /delete row, which asks with the chat's delete question; Cancel and Escape keep the chat, and Delete removes it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const { composer, chatFile } = await chatWithPingPong(page, realApp);

    // `/delete` names the app's own row exactly; Enter on it opens the question.
    await composer.fill("/delete");
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

    await composer.fill("/delete");
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

    await composer.fill("/delete");
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

/** Types `/branch`, then shoots the /branch row of the slash list in the page's theme. */
async function shootBranchRow(page: Page, composer: Locator, file: string): Promise<void> {
  await composer.fill("/branch");
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
    "S9b: /rewind and /branch pick the /branch row, which opens the panel with the rewind header",
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
      await chooseRow(page, composer, "/branch", /^\/branch/);
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

/*
 * Issue 2175, S9c: a typed `/fork` runs the app's own fork. It forks the open chat into a copy through the conversation
 * transition port, moves the view to the copy and writes a note there; the original stays in the list. Words after the
 * name are refused and nothing is sent. A chat whose turn is running is refused with a header note that says to wait.
 * Real omp 18.12.2 on the test machine, in the harness's throwaway home: no test touches a real session.
 */

const FORK_DONE =
  "Forked. You are now in the copy of your chat. The original is still in your list.";
const FORK_RUNNING = "Wait for this chat's turn to finish, then fork it.";
const FORK_WORDS =
  "/fork on its own forks this chat here. Anything after it, such as pane or window, only works in omp's terminal, so nothing was sent.";

/** The note `/fork` writes into the copy it opens: the transcript's notices list draws it. */
function forkNote(page: Page): Locator {
  return page.getByRole("region", { name: "Notices in this conversation" }).getByText(FORK_DONE);
}

/** The chat's one session file on disk before any fork: the seeded chat. */
async function seededFile(realApp: RealApp): Promise<string> {
  const files = await sessionFiles(realApp);
  expect(files).toHaveLength(1);
  const [file] = files;
  if (file === undefined) throw new Error("the seeded chat has no session file");
  return file;
}

/** The lines of one session file as omp wrote them, without the empty text after the last one. */
async function sessionLines(realApp: RealApp, file: string): Promise<string[]> {
  const text = await readFile(join(realApp.agentDir, "sessions", file), "utf8");
  return text.split("\n").filter((line) => line !== "");
}

/** Types `/fork`, then shoots the /fork row of the slash list in the page's theme. */
async function shootForkRow(page: Page, composer: Locator, file: string): Promise<void> {
  await composer.fill("/fork");
  const row = listRow(page, /^\/fork/);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("Fork this chat into a copy and open it. The original is kept.");
  // The row is painted with the app's own colour, not the browser's default black.
  expect(await colourOf(row)).not.toBe("rgb(0, 0, 0)");
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, file), fullPage: true });
}

realTest.describe("S9c: /fork forks the open chat into a copy and opens it", () => {
  realTest.use({ seedEntries: { entries } });

  realTest(
    "S9c: a typed /fork picks the /fork row, which opens a copy of the chat with its note; the list has two rows and the original keeps its lines",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      const composer = await openSeededChat(page);
      const original = await seededFile(realApp);
      const originalLines = await sessionLines(realApp, original);

      // `/fork` names the app's own row exactly, so Enter on it forks the chat.
      await chooseRow(page, composer, "/fork", /^\/fork/);

      await expect(forkNote(page)).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => sessionFiles(realApp), { timeout: 60_000 }).toHaveLength(2);
      // The copy is open: its transcript shows the three messages the chat had.
      const transcript = page.getByRole("region", { name: "Conversation transcript" });
      for (const message of ["first S9b message", "second S9b message", "third S9b message"]) {
        await expect(transcript.getByText(message, { exact: true })).toBeVisible({
          timeout: 60_000,
        });
      }
      const rows = page.getByRole("listbox", { name: "Session list" }).getByRole("option");
      await expect(rows).toHaveCount(2, { timeout: 60_000 });
      await expect(composer).toBeFocused({ timeout: 30_000 });
      // The original keeps every line it had: the copy is a new file.
      expect(await sessionLines(realApp, original)).toEqual(expect.arrayContaining(originalLines));
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "S9c: words after /fork are refused under the message box, no copy is made, and the text stays",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      const composer = await openSeededChat(page);

      await composer.fill("/fork pane");
      await composer.press("Enter");
      await expect(
        page.locator('[data-composer-error="true"]').filter({ hasText: FORK_WORDS }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(composer).toHaveValue("/fork pane");
      expect(await sessionFiles(realApp)).toHaveLength(1);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "S9c: while a reply runs, /fork says to wait and makes no copy, and the reply still finishes",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open();
      const composer = await openSeededChat(page);
      const stop = page.getByRole("button", { name: "Stop generating" });

      // `stream_held` keeps the reply open until the spec writes release-held-reply (see
      // fake-openai-server.ts and fix-1302-running-chat.spec.ts): the chat is busy from here.
      await sendPrompt(composer, "stream_held S9c");
      await expect(stop).toBeVisible({ timeout: 120_000 });

      await chooseRow(page, composer, "/fork", /^\/fork/);
      await expect(headerNote(page, FORK_RUNNING)).toBeVisible({ timeout: 30_000 });
      expect(await sessionFiles(realApp)).toHaveLength(1);

      await writeFile(join(realApp.agentDir, "release-held-reply"), "");
      await expect(stop).toHaveCount(0, { timeout: 120_000 });
      expect(await sessionFiles(realApp)).toHaveLength(1);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "S9c: the /fork row and the copy's note read in light mode at 1280 px",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      await mkdir(screenshots, { recursive: true });
      const page = await realApp.open();
      const composer = await openSeededChat(page);
      await shootForkRow(page, composer, "fix-2175-s9c-list-light-1280.png");

      await chooseRow(page, composer, "/fork", /^\/fork/);
      const note = forkNote(page);
      await expect(note).toBeVisible({ timeout: 60_000 });
      // The note is painted with the app's own colour, not the browser's default black.
      expect(await colourOf(note)).not.toBe("rgb(0, 0, 0)");
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, "fix-2175-s9c-note-light-1280.png"),
        fullPage: true,
      });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("S9c: the /fork row reads in dark mode at 1280 px", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const composer = await openSeededChat(page);
    await shootForkRow(page, composer, "fix-2175-s9c-list-dark-1280.png");
    // The copy's note in dark mode: picking the row forks the chat and writes the note into the copy.
    await chooseRow(page, composer, "/fork", /^\/fork/);
    const note = page
      .getByRole("region", { name: "Notices in this conversation" })
      .getByText(FORK_DONE);
    await expect(note).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9c-note-dark-1280.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  });

  realTest("S9c: the copy's fork note fits a 390 px screen", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    const composer = await openSeededChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    // The `/fork` list at 390 px: the row fits the screen and keeps its description before Enter picks it.
    await shootForkRow(page, composer, "fix-2175-s9c-list-light-390.png");
    await expectInsideWidth(listRow(page, /^\/fork/), 390);

    await chooseRow(page, composer, "/fork", /^\/fork/);
    const note = forkNote(page);
    await expect(note).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await expectInsideWidth(note, 390);
    // The note is painted with the app's own colour, not the browser's default black.
    expect(await colourOf(note)).not.toBe("rgb(0, 0, 0)");
    await page.screenshot({
      path: join(screenshots, "fix-2175-s9c-note-light-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  });
});
