import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { holdFileSearch, newHeldFileSearch } from "./hold-file-search";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

// File search lists git files, so the chat's folder is a git repository with two files that match "RE".
realTest.use({
  seedWorkspace: { files: { "README.md": "# demo\n", "REPORT.md": "# report\n" }, gitRepo: true },
});

/**
 * The first row is highlighted a moment after the rows render (`waitForHighlight` in trigger-keys.test.tsx): an arrow key
 * pressed before that moves nothing, so the test waits for the highlight before it presses one.
 */
async function expectHighlighted(page: Page): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toHaveAttribute("aria-activedescendant", /.+/, { timeout: 30_000 });
}

/** The emoji list above the composer, once its first emoji has loaded and is highlighted. */
async function emojiOptions(page: Page): Promise<Locator> {
  const options = page.getByRole("listbox", { name: "Emoji suggestions" }).getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 30_000 });
  await expectHighlighted(page);
  return options;
}

/** The file list above the composer, once its first file has loaded and is highlighted. */
async function fileOptions(page: Page): Promise<Locator> {
  const options = page.getByRole("listbox", { name: "File suggestions" }).getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 30_000 });
  await expectHighlighted(page);
  return options;
}

/** The conversation's messages: where a sent message appears (the composer's own text is not a message). */
function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/** The shell draws with the app's own background, not the browser's default: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "#818: Enter on the highlighted emoji inserts it and sends nothing",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill(":smi");
    await emojiOptions(page);

    await composer.press("Enter");
    await expect(composer).toHaveValue(/😄/);
    await expect(page.getByText(":smi", { exact: true })).toHaveCount(0);
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
  },
);

realTest(
  "#818: ArrowDown then Enter inserts the emoji that is highlighted",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill(":smi");
    const options = await emojiOptions(page);

    await composer.press("ArrowDown");
    // Enter chooses once the highlight has moved to the second emoji.
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await composer.press("Enter");
    // The second emoji for ":smi" is 😸 (:smile_cat:); the first, 😄, must not be inserted.
    await expect(composer).toHaveValue(/😸/);
    await expect(page.getByText(":smi", { exact: true })).toHaveCount(0);
  },
);

realTest(
  "#818: ArrowDown then Enter inserts the file that is highlighted",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    // The file search's answer is held back, so the first list shown is the answer for "RE" (not cached files).
    const hold = newHeldFileSearch();
    const page = await realApp.open({ beforeLoad: (target) => holdFileSearch(target, hold) });
    const composer = await startChat(page);
    await composer.fill("@RE");
    const list = page.getByRole("listbox", { name: "File suggestions" });
    await expect(list.getByRole("status")).toHaveText("Searching files…");
    hold.release();
    const options = await fileOptions(page);
    // The list shows the answer for "RE" before the highlight moves: README.md first, then REPORT.md.
    await expect(options).toHaveText([/README\.md/, /REPORT\.md/]);

    await composer.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await composer.press("Enter");
    await expect(composer).toHaveValue("@REPORT.md ");
    await expect(transcript(page).getByText("@RE", { exact: true })).toHaveCount(0);
  },
);

realTest(
  "#818: keys pressed while the file list is still loading do not send the text",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    // The file search's answer is held back, so the list is still loading when the keys arrive.
    const hold = newHeldFileSearch();
    const page = await realApp.open({ beforeLoad: (target) => holdFileSearch(target, hold) });
    const composer = await startChat(page);
    await composer.fill("@RE");
    const list = page.getByRole("listbox", { name: "File suggestions" });
    await expect(list.getByRole("status")).toHaveText("Searching files…");
    await composer.press("ArrowDown");
    await composer.press("Enter");
    // Still loading: the keys chose nothing and sent nothing.
    await expect(composer).toHaveValue("@RE");
    await expect(transcript(page).getByText("@RE", { exact: true })).toHaveCount(0);

    // The answer arrives. The Enter kept while it loaded is dropped, so the text is still in the composer.
    hold.release();
    const options = await fileOptions(page);
    await expect(composer).toHaveValue("@RE");
    await expect(transcript(page).getByText("@RE", { exact: true })).toHaveCount(0);
    // The answer for "RE" is on screen before the highlight moves: README.md first, then REPORT.md.
    await expect(options).toHaveText([/README\.md/, /REPORT\.md/]);

    await composer.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await composer.press("Enter");
    await expect(composer).toHaveValue("@REPORT.md ");
  },
);

realTest(
  "#818: the inserted emoji reads in light, dark and at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill(":smi");
    await emojiOptions(page);
    await composer.press("Enter");
    await expect(composer).toHaveValue(/😄/);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-818-emoji-light.png"), fullPage: true });

    // Dark the way a person gets it: the remembered Dark choice, read before the page paints.
    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(dark.locator("html")).toHaveClass(/dark/);
    const darkComposer = await startChat(dark);
    await darkComposer.fill(":smi");
    await emojiOptions(dark);
    await darkComposer.press("Enter");
    await expect(darkComposer).toHaveValue(/😄/);
    await waitForFiniteAnimations(dark);
    await expectStylesLoaded(dark);
    await dark.screenshot({ path: join(screenshots, "fix-818-emoji-dark.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toBeInViewport();
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({ path: join(screenshots, "fix-818-emoji-narrow.png"), fullPage: true });
  },
);

realTest(
  "#818: a plain message still sends when no list is open",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "hello there");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
  },
);
