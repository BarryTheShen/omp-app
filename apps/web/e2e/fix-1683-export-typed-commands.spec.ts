import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Download, Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue 1683. D4's export commands are mounted in the open chat: typed `/export` opens the export picker over this
 * chat, and typed `/dump`, `/dump all` and `/dump anon` save omp's reports as files through the download path. Before
 * the mount, omp's own text answered those words in the chat.
 */

/** The prompt the chat starts from, and the fake model's answer to a prompt with no keyword in it. */
const PROMPT = "Hello for the export check";
const ANSWER = "pong";

/** The last line of an anonymized archive report: omp's session-anonymizer.ts, ANONYMIZED_REVIEW_NOTE (v18.8.9). */
const ANONYMIZED_NOTE =
  "Turn contents and error text are redacted and paths/literals replaced; metadata such as model names is kept — review before sharing.";

/** The export picker, which lists the chat's three formats. */
function picker(page: Page): Locator {
  return page.getByRole("listbox", { name: "Export this chat" });
}

/** Reads a download's text, failing the test if the browser did not keep the file. */
async function textOf(download: Download): Promise<string> {
  const path = await download.path();
  if (path === null) throw new Error(`the browser did not keep ${download.suggestedFilename()}`);
  return readFileSync(path, "utf8");
}

realTest(
  "typed /export opens the export picker, and typed /dump, /dump all and /dump anon save omp's reports as files",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    await expect(page.getByText(ANSWER, { exact: true }).first()).toBeVisible({ timeout: 90_000 });

    // Typed /export opens the app's picker; omp's own export text ("Session exported to: ...") never reaches the chat.
    await sendPrompt(composer, "/export");
    await expect(picker(page)).toBeVisible({ timeout: 30_000 });
    await expect(picker(page).getByRole("option")).toHaveCount(3);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1683-export-picker-light.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1683-export-picker-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1683-export-picker-390.png"),
      fullPage: true,
    });
    if (desktop !== null) await page.setViewportSize(desktop);

    // Markdown: the whole chat under its headings, saved as omp-chat.md.
    const markdownFile = page.waitForEvent("download");
    await picker(page).getByRole("option", { name: "Markdown file" }).click();
    await page.getByRole("button", { name: "Choose", exact: true }).click();
    const markdown = await markdownFile;
    expect(markdown.suggestedFilename()).toBe("omp-chat.md");
    expect((await textOf(markdown)).startsWith(`## You\n\n${PROMPT}\n\n## omp\n\n${ANSWER}`)).toBe(
      true,
    );

    // Typed /dump saves omp's session dump, which opens with its system prompt or its configuration.
    const dumpFile = page.waitForEvent("download");
    await sendPrompt(composer, "/dump");
    const dump = await dumpFile;
    expect(dump.suggestedFilename()).toBe("omp-dump.md");
    expect(await textOf(dump)).toMatch(/^## (System Prompt|Configuration)\n/);

    // Typed /dump all saves omp's archive report as text.
    const archiveFile = page.waitForEvent("download");
    await sendPrompt(composer, "/dump all");
    const archive = await archiveFile;
    expect(archive.suggestedFilename()).toBe("omp-dump-archive.txt");
    expect((await textOf(archive)).startsWith("Session dump archive: ")).toBe(true);

    // Typed /dump anon saves the anonymized archive report, which ends with omp's review note.
    const anonFile = page.waitForEvent("download");
    await sendPrompt(composer, "/dump anon");
    const anon = await anonFile;
    expect(anon.suggestedFilename()).toBe("omp-dump-anonymized.txt");
    const anonText = await textOf(anon);
    expect(anonText.startsWith("Session dump archive: ")).toBe(true);
    expect(anonText.trimEnd().split("\n").at(-1)).toBe(ANONYMIZED_NOTE);

    await expect(page.getByText("Session exported to:", { exact: false })).toHaveCount(0);
    await expect(
      page.getByText(/^Download requested for omp-dump-anonymized\.txt \(\d+ characters\)\.$/),
    ).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1683-dump-anon-light.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
