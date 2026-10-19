/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Browser, Download, Page } from "@playwright/test";
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
const PAGE_NAME = "d4-3-export-check";
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

const TERMINAL_ONLY_OPEN = "/open only runs in omp's terminal, so nothing was sent.";
const TERMINAL_ONLY_RECORD = "/record only runs in omp's terminal, so nothing was sent.";

function buildCheckPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D4/export/playground.tsx",
      "--outdir",
      `dist/${PAGE_NAME}`,
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const js = readdirSync(PAGE_ROOT).find((file) => file.endsWith(".js"));
  const appCss = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!js || !appCss) throw new Error("The D4.3 check page did not build with the app stylesheet.");
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
    <title>D4.3 export check</title>
  </head>
  <body>
    <div id="d4-3-export-root"></div>
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

/** Opens the check page on the chat and waits until it has read the chat's messages. */
async function openCheck(browser: Browser, url: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(url);
  await expect(page.getByTestId("d4-3-readiness")).toContainText("messages in this chat", {
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

/** A real chat: the fenced prompt with its bash tool call, then a follow-up reply. */
async function buildChat(realApp: RealApp): Promise<string> {
  const app = await realApp.open();
  const composer = await startChat(app);
  await sendPrompt(composer, PROMPT);
  await expect(app.getByText("tool said: fixture-tool", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
  await sendPrompt(composer, "hello again");
  await expect(app.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });
  return new URL(app.url()).origin;
}

/** Opens the export picker and chooses a format by its label, then confirms with Choose. */
async function chooseFormat(page: Page, label: string): Promise<void> {
  await page.getByTestId("d4-3-export").click();
  const list = page.getByRole("listbox", { name: "Export this chat" });
  await list.getByRole("option", { name: label }).click();
  await page.getByRole("button", { name: "Choose", exact: true }).click();
}

/** Reads a download's text, failing the test if the browser did not keep the file. */
async function textOf(download: Download): Promise<string> {
  const path = await download.path();
  if (path === null) throw new Error(`the browser did not keep ${download.suggestedFilename()}`);
  return readFileSync(path, "utf8");
}

realTest(
  "exports the chat as Markdown, plain text and an HTML page omp writes, and the dumps as files",
  async ({ realApp, browser }) => {
    const origin = await buildChat(realApp);
    const check = await openCheck(browser, checkUrl(origin, realApp.token));
    const errors = watchErrors(check);
    const outcome = check.getByTestId("d4-3-outcome");

    // Markdown: the exact source of each message, under its author's heading.
    const markdownFile = check.waitForEvent("download");
    await chooseFormat(check, "Markdown file");
    const markdown = await markdownFile;
    expect(markdown.suggestedFilename()).toBe("omp-chat.md");
    const markdownText = await textOf(markdown);
    expect(
      markdownText.startsWith(`## You\n\n${PROMPT}\n\n## omp\n\ntool said: fixture-tool`),
    ).toBe(true);
    expect(markdownText).toContain("## omp\n\n");
    expect(markdownText).toContain("pong");
    await expect(outcome).toHaveText(/^Download requested for omp-chat\.md \(\d+ characters\)\.$/);

    // Plain text: each message's text, labelled, with the Markdown marks omp wrote still in place.
    const plainFile = check.waitForEvent("download");
    await chooseFormat(check, "Plain text file");
    const plain = await plainFile;
    expect(plain.suggestedFilename()).toBe("omp-chat.txt");
    expect(
      (await textOf(plain)).startsWith(`You:\n${PROMPT}\n\nomp:\ntool said: fixture-tool`),
    ).toBe(true);

    // HTML: omp writes the page in the chat's folder; the app reports where, and downloads nothing.
    await chooseFormat(check, "HTML page");
    await expect(outcome).toHaveText(
      /^omp saved the chat as a web page in this chat's folder: .+\.html$/,
    );
    const reported = (await outcome.textContent())?.replace(
      "omp saved the chat as a web page in this chat's folder: ",
      "",
    );
    if (reported === undefined || reported === "") throw new Error("no HTML path was reported");
    const htmlPath = isAbsolute(reported) ? reported : join(realApp.folder, reported);
    expect(existsSync(htmlPath)).toBe(true);
    // omp's template (packages/coding-agent/src/export/html/template.html:1, 8, 49) embeds the session as base64.
    const html = readFileSync(htmlPath, "utf8");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Session Export</title>");
    expect(html).toContain('id="session-data"');

    // /dump: omp's session report, saved as Markdown.
    const dumpFile = check.waitForEvent("download");
    await check.getByTestId("d4-3-dump").click();
    const dump = await dumpFile;
    expect(dump.suggestedFilename()).toBe("omp-dump.md");
    expect((await textOf(dump)).startsWith("## System Prompt\n")).toBe(true);
    await expect(outcome).toHaveText(/^Download requested for omp-dump\.md \(\d+ characters\)\.$/);

    // /dump all: the archive report, saved as text.
    const dumpAllFile = check.waitForEvent("download");
    await check.getByTestId("d4-3-dump-all").click();
    const dumpAll = await dumpAllFile;
    expect(dumpAll.suggestedFilename()).toBe("omp-dump-archive.txt");
    expect((await textOf(dumpAll)).startsWith("Session dump archive: ")).toBe(true);

    // The terminal-only commands say why they do nothing here; neither claims to have acted.
    await check.getByTestId("d4-3-open").click();
    await expect(outcome).toHaveText(TERMINAL_ONLY_OPEN);
    await check.getByTestId("d4-3-record").click();
    await expect(outcome).toHaveText(TERMINAL_ONLY_RECORD);

    expect(errors).toEqual([]);
  },
);

realTest(
  "a cancelled picker exports nothing, and the picker shows its three formats",
  async ({ realApp, browser }) => {
    const origin = await buildChat(realApp);
    const check = await openCheck(browser, checkUrl(origin, realApp.token));
    const errors = watchErrors(check);
    const outcome = check.getByTestId("d4-3-outcome");

    await check.getByTestId("d4-3-export").click();
    const list = check.getByRole("listbox", { name: "Export this chat" });
    const options = list.getByRole("option");
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toContainText("Markdown file");
    await expect(options.nth(1)).toContainText("Plain text file");
    await expect(options.nth(2)).toContainText("HTML page");
    await waitForFiniteAnimations(check);
    await check.screenshot({
      path: join(screenshots, "d4.3-export-picker-light.png"),
      fullPage: true,
    });
    await check.keyboard.press("Escape");
    await expect(outcome).toHaveText("Nothing was exported.");
    expect(errors).toEqual([]);
  },
);

realTest(
  "the export picker reads in dark and at 390 px, with its styles loaded",
  async ({ realApp, browser }) => {
    const origin = await buildChat(realApp);
    const dark = await openCheck(browser, checkUrl(origin, realApp.token, "?theme=dark"));
    const errors = watchErrors(dark);
    // The app stylesheet is loaded: the page body takes the dark token, not the browser's white default.
    const darkBackground = await dark.evaluate(
      () => getComputedStyle(document.querySelector("main") ?? document.body).backgroundColor,
    );
    expect(darkBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(darkBackground).not.toBe("rgb(255, 255, 255)");
    await dark.getByTestId("d4-3-export").click();
    await expect(dark.getByRole("listbox", { name: "Export this chat" })).toBeVisible();
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "d4.3-export-picker-dark.png"),
      fullPage: true,
    });
    await dark.keyboard.press("Escape");
    await expect(dark.getByTestId("d4-3-outcome")).toHaveText("Nothing was exported.");
    expect(errors).toEqual([]);

    const narrow = await openCheck(browser, checkUrl(origin, realApp.token));
    await narrow.setViewportSize({ width: 390, height: 844 });
    await narrow.getByTestId("d4-3-export").click();
    await expect(narrow.getByRole("listbox", { name: "Export this chat" })).toBeVisible();
    await waitForFiniteAnimations(narrow);
    await narrow.screenshot({
      path: join(screenshots, "d4.3-export-picker-390.png"),
      fullPage: true,
    });
    await narrow.keyboard.press("Escape");
    await expect(narrow.getByTestId("d4-3-outcome")).toHaveText("Nothing was exported.");
  },
);

/** The number of messages the check page holds, from its readiness line. */
async function messageCountOf(page: Page): Promise<number> {
  const text = (await page.getByTestId("d4-3-readiness").textContent()) ?? "";
  const count = Number(/Ready: (\d+) messages/.exec(text)?.[1]);
  if (Number.isNaN(count)) throw new Error(`no message count in "${text}"`);
  return count;
}

realTest(
  "a chat read in small windows still exports whole: the older windows load before the file is made",
  async ({ realApp, browser }) => {
    const origin = await buildChat(realApp);
    const whole = await openCheck(browser, checkUrl(origin, realApp.token));
    const wholeCount = await messageCountOf(whole);
    // A 1 KiB window holds only the newest entries of this chat, so the first prompt is in an older window.
    const check = await openCheck(browser, checkUrl(origin, realApp.token, "?window=1024"));
    expect(await messageCountOf(check)).toBeLessThan(wholeCount);
    const errors = watchErrors(check);
    const markdownFile = check.waitForEvent("download");
    await chooseFormat(check, "Markdown file");
    const markdown = await textOf(await markdownFile);
    expect(markdown.startsWith(`## You\n\n${PROMPT}\n\n## omp\n\ntool said: fixture-tool`)).toBe(
      true,
    );
    expect(markdown.match(/^## .+$/gm)).toEqual(["## You", "## omp", "## You", "## omp"]);
    expect(markdown).toContain("hello again");
    expect(errors).toEqual([]);
  },
);
