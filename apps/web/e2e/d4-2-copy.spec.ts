/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import type { RealApp } from "./real-omp";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PAGE_NAME = "d4-2-copy-check";
const PAGE_ROOT = join(DIST_ROOT, PAGE_NAME);

/** The prompt the chat starts from: a TypeScript block, a shell block and a bash tool call. */
const PROMPT = [
  "Here is a snippet:",
  "```ts",
  "const answer = 42;",
  "```",
  "And a shell step:",
  "```bash",
  "echo inside",
  "```",
  "run_bash",
].join("\n");

function buildCheckPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D4/copy/playground.tsx",
      "--outdir",
      `dist/${PAGE_NAME}`,
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const js = readdirSync(PAGE_ROOT).find((file) => file.endsWith(".js"));
  const appCss = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!js || !appCss) throw new Error("The D4.2 check page did not build with the app stylesheet.");
  writeFileSync(
    join(DIST_ROOT, `${PAGE_NAME}.html`),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="stylesheet" href="/assets/${appCss}" />
    <title>D4.2 copy picker check</title>
  </head>
  <body>
    <div id="d4-2-copy-root"></div>
    <script type="module" src="/${PAGE_NAME}/${js}"></script>
  </body>
</html>
`,
  );
}

realTest.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    buildCheckPage();
  }),
);

realTest.setTimeout(300_000);

function checkUrl(origin: string, token: string, query = ""): string {
  return `${origin}/${PAGE_NAME}.html${query}#token=${encodeURIComponent(token)}`;
}

/** Opens a check page on the chat, with clipboard access granted the way a user would grant it. */
async function openCheck(browser: Browser, url: string): Promise<Page> {
  const page = await browser.newPage();
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
  await page.goto(url);
  await expect(page.getByTestId("d4-2-readiness")).toContainText("messages in this chat", {
    timeout: 60_000,
  });
  return page;
}

/** Every console error and uncaught page error from a page, so a test can prove there were none. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

/**
 * A real chat: the fenced prompt, its bash tool call and result, a reply, and a bash command run from the
 * check page's runtime (the bash path the composer's Bash mode will use). Returns the app's origin.
 */
async function buildChat(realApp: RealApp, browser: Browser): Promise<string> {
  const app = await realApp.open();
  const composer = await startChat(app);
  await sendPrompt(composer, PROMPT);
  await expect(app.getByText("tool said: fixture-tool", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await sendPrompt(composer, "hello again");
  await expect(app.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });
  const origin = new URL(app.url()).origin;
  const seed = await openCheck(browser, checkUrl(origin, realApp.token));
  await seed.getByTestId("d4-2-seed-bash").click({ timeout: 30_000 });
  await expect(seed.getByTestId("d4-2-outcome")).toHaveText('Ran "echo copy-me" in bash.', {
    timeout: 60_000,
  });
  await seed.close();
  return origin;
}

/** Opens the picker, chooses a target by its label, and confirms with Choose. */
async function choose(page: Page, label: string): Promise<void> {
  await page.getByTestId("d4-2-open-picker").click();
  const list = page.getByRole("listbox", { name: "Copy from this chat" });
  await list.getByRole("option", { name: label }).click();
  await page.getByRole("button", { name: "Choose", exact: true }).click();
}

realTest(
  "copies exact Markdown, fence-free code and commands from a real chat",
  async ({ realApp, browser }) => {
    const origin = await buildChat(realApp, browser);
    const check = await openCheck(browser, checkUrl(origin, realApp.token));
    const errors = watchErrors(check);
    const outcome = check.getByTestId("d4-2-outcome");

    await choose(check, "Message 1 from you");
    await expect(outcome).toHaveText(`Copied "Message 1 from you" (${PROMPT.length} characters).`);
    expect(await check.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);

    await choose(check, "Code block 1 in message 1");
    await expect(outcome).toHaveText('Copied "Code block 1 in message 1" (18 characters).');
    expect(await check.evaluate(() => navigator.clipboard.readText())).toBe("const answer = 42;");

    await choose(check, "Output 1 in message 6");
    await expect(outcome).toHaveText('Copied "Output 1 in message 6" (7 characters).');
    expect(await check.evaluate(() => navigator.clipboard.readText())).toBe("copy-me");

    // Keyboard: search the list and press Enter on the match, which copies it at once (there is no Choose step).
    await check.getByTestId("d4-2-open-picker").click();
    const filter = check.getByRole("textbox", { name: "Filter options" });
    await filter.fill("latest command");
    await filter.press("Enter");
    await expect(outcome).toHaveText('Copied "Latest command" (12 characters).');
    expect(await check.evaluate(() => navigator.clipboard.readText())).toBe("echo copy-me");
    await expect(check.getByTestId("d4-2-open-picker")).toBeFocused();

    expect(errors).toEqual([]);
  },
);

realTest(
  "a refused clipboard offers a download or a copy by hand, and never reports a copy",
  async ({ realApp, browser }) => {
    const origin = await buildChat(realApp, browser);
    const denied = await openCheck(browser, checkUrl(origin, realApp.token, "?clipboard=denied"));
    const errors = watchErrors(denied);
    const outcome = denied.getByTestId("d4-2-outcome");

    await denied.getByTestId("d4-2-open-picker").click();
    await denied
      .getByRole("listbox", { name: "Copy from this chat" })
      .getByRole("option", { name: "Code block 1 in message 1" })
      .click();
    await denied.getByRole("button", { name: "Choose", exact: true }).click();
    const recovery = denied.getByRole("listbox", { name: "The clipboard refused the copy" });
    await expect(recovery).toBeVisible();
    await waitForFiniteAnimations(denied);
    await denied.screenshot({
      path: join(screenshots, "d4.2-copy-refused-light.png"),
      fullPage: true,
    });

    const downloaded = denied.waitForEvent("download");
    await recovery.getByRole("option", { name: "Download it as a file" }).click();
    await denied.getByRole("button", { name: "Choose", exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("code-block-1-in-message-1.txt");
    const savedPath = await download.path();
    expect(savedPath === null ? "" : readFileSync(savedPath, "utf8")).toBe("const answer = 42;");
    await expect(outcome).toHaveText(
      "Download requested for code-block-1-in-message-1.txt (18 characters). Nothing was copied to the clipboard.",
    );
    await expect(denied.getByTestId("d4-2-open-picker")).toBeFocused();

    await denied.getByTestId("d4-2-open-picker").click();
    await denied
      .getByRole("listbox", { name: "Copy from this chat" })
      .getByRole("option", { name: "Command 1 in message 1" })
      .click();
    await denied.getByRole("button", { name: "Choose", exact: true }).click();
    await denied
      .getByRole("listbox", { name: "The clipboard refused the copy" })
      .getByRole("option", { name: "Show the text to copy by hand" })
      .click();
    await denied.getByRole("button", { name: "Choose", exact: true }).click();
    const byHand = denied.getByRole("textbox", { name: 'Copy "Command 1 in message 1" by hand' });
    await expect(byHand).toHaveValue("echo inside");
    await waitForFiniteAnimations(denied);
    await denied.screenshot({
      path: join(screenshots, "d4.2-copy-by-hand-light.png"),
      fullPage: true,
    });
    await denied.getByRole("button", { name: "Done", exact: true }).click();
    await expect(denied.getByTestId("d4-2-open-picker")).toBeFocused();
    await expect(outcome).toHaveText(
      'Showed "Command 1 in message 1" (11 characters) so you can copy it by hand. Nothing was copied to the clipboard.',
    );

    expect(errors).toEqual([]);
  },
);

realTest("the copy picker in light, dark and narrow", async ({ realApp, browser }) => {
  const origin = await buildChat(realApp, browser);
  const variants = [
    { name: "light", query: "", width: 1280 },
    { name: "dark", query: "?theme=dark", width: 1280 },
    { name: "narrow", query: "", width: 390 },
  ] as const;
  for (const variant of variants) {
    const page = await openCheck(browser, checkUrl(origin, realApp.token, variant.query));
    const errors = watchErrors(page);
    await page.setViewportSize({ width: variant.width, height: 844 });
    await page.getByTestId("d4-2-open-picker").click();
    await expect(page.getByRole("listbox", { name: "Copy from this chat" })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, `d4.2-copy-picker-${variant.name}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await page.close();
  }
});

realTest("the refused-clipboard dialogs in dark", async ({ realApp, browser }) => {
  const origin = await buildChat(realApp, browser);
  const dark = await openCheck(
    browser,
    checkUrl(origin, realApp.token, "?clipboard=denied&theme=dark"),
  );
  const errors = watchErrors(dark);
  await dark.getByTestId("d4-2-open-picker").click();
  await dark
    .getByRole("listbox", { name: "Copy from this chat" })
    .getByRole("option", { name: "Command 1 in message 1" })
    .click();
  await dark.getByRole("button", { name: "Choose", exact: true }).click();
  const recovery = dark.getByRole("listbox", { name: "The clipboard refused the copy" });
  await expect(recovery).toBeVisible();
  await waitForFiniteAnimations(dark);
  await dark.screenshot({ path: join(screenshots, "d4.2-copy-refused-dark.png"), fullPage: true });
  await recovery.getByRole("option", { name: "Show the text to copy by hand" }).click();
  await dark.getByRole("button", { name: "Choose", exact: true }).click();
  await expect(
    dark.getByRole("textbox", { name: 'Copy "Command 1 in message 1" by hand' }),
  ).toHaveValue("echo inside");
  await waitForFiniteAnimations(dark);
  await dark.screenshot({ path: join(screenshots, "d4.2-copy-by-hand-dark.png"), fullPage: true });
  await dark.getByRole("button", { name: "Done", exact: true }).click();
  expect(errors).toEqual([]);
});

realTest(
  "the copy by hand view says Done, is read-only, and keeps a gap from the screen edges at 390 px",
  async ({ realApp, browser }) => {
    const origin = await buildChat(realApp, browser);
    const variants = [
      { name: "light", query: "?clipboard=denied", width: 1280 },
      { name: "dark", query: "?clipboard=denied&theme=dark", width: 1280 },
      { name: "narrow", query: "?clipboard=denied", width: 390 },
    ] as const;
    for (const variant of variants) {
      const page = await openCheck(browser, checkUrl(origin, realApp.token, variant.query));
      const errors = watchErrors(page);
      await page.setViewportSize({ width: variant.width, height: 844 });
      await choose(page, "Command 1 in message 1");
      await page
        .getByRole("listbox", { name: "The clipboard refused the copy" })
        .getByRole("option", { name: "Show the text to copy by hand" })
        .click();
      await page.getByRole("button", { name: "Choose", exact: true }).click();

      const byHand = page.getByRole("textbox", { name: 'Copy "Command 1 in message 1" by hand' });
      await expect(byHand).toHaveValue("echo inside");
      await expect(byHand).toBeEditable({ editable: false });
      const dialog = page.getByRole("dialog").filter({ has: byHand });
      await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
      await expect(dialog.getByText("saves")).toHaveCount(0);
      const box = await dialog.boundingBox();
      expect(box?.x ?? 0).toBeGreaterThanOrEqual(12);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(variant.width - 12);
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, `fix-814-by-hand-${variant.name}.png`),
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect(byHand).toHaveCount(0);
      expect(errors).toEqual([]);
      await page.close();
    }
  },
);
