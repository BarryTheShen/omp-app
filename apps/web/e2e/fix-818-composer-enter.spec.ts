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

// File search lists git files, so the chat's folder is a git repository with two files that match "RE".
realTest.use({
  seedWorkspace: { files: { "README.md": "# demo\n", "REPORT.md": "# report\n" }, gitRepo: true },
});

/** The emoji list above the composer, once its first emoji has loaded. */
async function emojiOptions(page: Page): Promise<Locator> {
  const options = page.getByRole("listbox", { name: "Emoji suggestions" }).getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 30_000 });
  return options;
}

/** The file list above the composer, once its first file has loaded. */
async function fileOptions(page: Page): Promise<Locator> {
  const options = page.getByRole("listbox", { name: "File suggestions" }).getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 30_000 });
  return options;
}

/** The conversation's messages: where a sent message appears (the composer's own text is not a message). */
function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/** The frames of a message that is a JSON object, with no type checks: a message that is not one has no fields. */
function frameOf(message: string | Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(String(message));
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** Delays the answer to each file search by `ms`, so the file list is still loading for that long. */
async function delayFileSearchAnswer(page: Page, ms: number): Promise<void> {
  await page.routeWebSocket(/\/ws/, (socket) => {
    const server = socket.connectToServer();
    const searches = new Set<unknown>();
    socket.onMessage((message) => {
      const frame = frameOf(message);
      if (frame.type === "call" && frame.port === "A1.fileSearch") searches.add(frame.id);
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = frameOf(message);
      if (frame.type === "result" && searches.has(frame.id)) {
        searches.delete(frame.id);
        setTimeout(() => {
          socket.send(message);
        }, ms);
        return;
      }
      socket.send(message);
    });
  });
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
    await emojiOptions(page);

    await composer.press("ArrowDown");
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
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill("@RE");
    await fileOptions(page);

    await composer.press("ArrowDown");
    await composer.press("Enter");
    await expect(composer).toHaveValue("@REPORT.md ");
    await expect(transcript(page).getByText("@RE", { exact: true })).toHaveCount(0);
  },
);

realTest(
  "#818: keys pressed while the file list is still loading do not send the text",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    // The list's answer comes 2 s late, so the list is still loading when ArrowDown and Enter arrive.
    const page = await realApp.open({
      beforeLoad: (target) => delayFileSearchAnswer(target, 2_000),
    });
    const composer = await startChat(page);
    await composer.fill("@RE");
    // A key that arrives before the list has opened goes to the composer, so the keys wait for the list to open.
    await expect(page.getByRole("listbox", { name: "File suggestions" })).toBeVisible();
    await composer.press("ArrowDown");
    await composer.press("Enter");
    // Once the list has loaded, the text is still in the composer: nothing was sent.
    await fileOptions(page);
    await expect(composer).toHaveValue("@RE");
    await expect(transcript(page).getByText("@RE", { exact: true })).toHaveCount(0);

    await composer.press("ArrowDown");
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
