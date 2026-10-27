/// <reference types="node" />
import { appendFile, readFile } from "node:fs/promises";
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

/**
 * #2737 (SDK plan H5.4c): omp's tool approval reaches the app as the chat host's typed `ui.approve`. The dialog shows
 * omp's choices in omp's order and answers the one taken by type, so omp acts on it: Approve Once asks again at the next
 * write, a folder grant covers the folder's next file, and the session answer covers the next write anywhere. omp asks
 * before a write in its approval modes "Ask and remember" (`always-ask-cached`, with the folder and file grants) and
 * "Always ask" (`always-ask`, with the session answer).
 */

realTest.setTimeout(180_000);

type ApprovalMode = "always-ask-cached" | "always-ask";

/** omp reads its approval mode when a chat starts: the harness's settings file gets the mode before the page opens. */
async function openInMode(
  realApp: RealApp,
  mode: ApprovalMode,
  theme: "light" | "dark",
): Promise<{ page: Page; composer: Locator }> {
  await appendFile(join(realApp.agentDir, "config.yml"), `\ntools:\n  approvalMode: ${mode}\n`);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript((name) => window.localStorage.setItem("omp-app.theme", name), theme),
  });
  const composer = await startChat(page);
  return { page, composer };
}

function writeTool(path: string, content: string): string {
  return `call_tool write ${JSON.stringify({ path, content })}`;
}

function approvalOf(page: Page): Locator {
  return page.getByRole("dialog", { name: "Allow tool: write" });
}

async function choose(dialog: Locator, label: string): Promise<void> {
  await dialog.getByRole("option", { name: label, exact: true }).click();
  await dialog.getByRole("button", { name: "Choose" }).click();
  await expect(dialog).toBeHidden();
}

/** The model's replies after its tool calls: one per finished call, whatever omp answered. */
function replies(page: Page): Locator {
  return page.getByText(/^tool said: /);
}

function fileIn(realApp: RealApp, path: string): Promise<string> {
  return readFile(join(realApp.folder, path), "utf8").catch(() => "(no file)");
}

async function capture(page: Page, dialog: Locator, name: string): Promise<void> {
  await expect(dialog).toBeVisible();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name) });
}

realTest(
  "Ask and remember (light): omp's choices in omp's order, and Approve Once asks again at the next write",
  async ({ realApp }) => {
    const { page, composer } = await openInMode(realApp, "always-ask-cached", "light");
    await sendPrompt(composer, writeTool("notes/a.txt", "one\n"));
    const dialog = approvalOf(page);
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    const folder = join(realApp.folder, "notes");
    await expect(dialog.getByRole("option")).toHaveText([
      `Approve Directory: ${folder}`,
      "Approve File",
      `Always Approve Directory: ${folder}`,
      "Always Approve File",
      "Approve Once",
      "Deny",
    ]);
    await capture(page, dialog, "fix-2737-approval-light.png");
    await choose(dialog, "Approve Once");
    await expect(replies(page)).toHaveCount(1, { timeout: 60_000 });
    expect(await fileIn(realApp, "notes/a.txt")).toBe("one\n");

    // Once covered only that call: omp asks before the next write in the same folder, and Deny keeps the file out.
    await sendPrompt(composer, writeTool("notes/b.txt", "two\n"));
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await choose(dialog, "Deny");
    await expect(replies(page)).toHaveCount(2, { timeout: 60_000 });
    expect(await fileIn(realApp, "notes/b.txt")).toBe("(no file)");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Ask and remember (dark): a folder grant lets the folder's next file be written without asking",
  async ({ realApp }) => {
    const { page, composer } = await openInMode(realApp, "always-ask-cached", "dark");
    await sendPrompt(composer, writeTool("notes/a.txt", "one\n"));
    const dialog = approvalOf(page);
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await capture(page, dialog, "fix-2737-approval-dark.png");
    await choose(dialog, `Approve Directory: ${join(realApp.folder, "notes")}`);
    await expect(replies(page)).toHaveCount(1, { timeout: 60_000 });
    expect(await fileIn(realApp, "notes/a.txt")).toBe("one\n");

    // The grant is omp's own, for the folder: the next file there is written with no question asked.
    await sendPrompt(composer, writeTool("notes/b.txt", "two\n"));
    await expect(replies(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(dialog).toHaveCount(0);
    expect(await fileIn(realApp, "notes/b.txt")).toBe("two\n");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Always ask (390 px): the session answer lets the next write anywhere go without asking",
  async ({ realApp }) => {
    const { page, composer } = await openInMode(realApp, "always-ask", "light");
    await page.setViewportSize({ width: 390, height: 844 });
    await sendPrompt(composer, writeTool("notes/a.txt", "one\n"));
    const dialog = approvalOf(page);
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByRole("option")).toHaveText([
      "Approve",
      "Approve write for this session",
      "Deny",
    ]);
    await capture(page, dialog, "fix-2737-approval-390.png");
    await choose(dialog, "Approve write for this session");
    await expect(replies(page)).toHaveCount(1, { timeout: 60_000 });
    expect(await fileIn(realApp, "notes/a.txt")).toBe("one\n");

    // The session answer covers the write tool for the rest of the chat, in another folder too.
    await sendPrompt(composer, writeTool("other/c.txt", "three\n"));
    await expect(replies(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(dialog).toHaveCount(0);
    expect(await fileIn(realApp, "other/c.txt")).toBe("three\n");
    expect(realApp.problems).toEqual([]);
  },
);
