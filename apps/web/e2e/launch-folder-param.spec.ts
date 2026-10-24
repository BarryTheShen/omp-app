import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { sessionBucketName } from "../../../packages/server/src/modules/A1/sessions/paths";
import {
  expect,
  narrowTo,
  type RealApp,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);

/**
 * #2613: with the app's server always running, `omp-app <folder>` finds it already running and opens the browser on
 * its launch link with `&folder=<absolute path>` added to the fragment. The page reads that folder once when it loads:
 * it is the workspace folder the app opens on, ahead of the one remembered from before, it is remembered like a folder
 * picked by hand, and it leaves the address bar together with the token.
 */

/** The workspace picker in the sessions sidebar. */
function picker(page: Page) {
  return page.getByRole("combobox", { name: "Workspace folder" });
}

/** Opens a tab in the same browser profile the way the browser opens the address `omp-app <folder>` prints. */
async function openFolderLink(
  realApp: RealApp,
  tab: Page,
  folder: string,
  problems: string[],
): Promise<Page> {
  const link = `${new URL(tab.url()).origin}/#token=${encodeURIComponent(realApp.token)}&folder=${encodeURIComponent(folder)}`;
  const page = await tab.context().newPage();
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  await page.goto(link);
  await expect(page.locator("[data-app-root='true']")).toBeVisible();
  return page;
}

/** The per-folder bucket of every chat file omp has written: one entry per chat, named for the folder it ran in. */
async function chatBuckets(realApp: RealApp): Promise<string[]> {
  try {
    const names = await readdir(join(realApp.agentDir, "sessions"), { recursive: true });
    return names
      .map(String)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => dirname(name));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

realTest(
  "a launch link with a folder opens the app on it, ahead of the remembered folder, and a New chat runs there",
  async ({ realApp }) => {
    const { folder, otherFolder } = realApp;
    const problems: string[] = [];

    // The first tab remembers the server's folder as a person does: by picking another folder, then this one again.
    const first = await realApp.open();
    await expect(picker(first)).toHaveValue(folder);
    await picker(first).selectOption("__other__");
    await first.getByRole("textbox", { name: "Other folder path" }).fill(otherFolder);
    await first.getByRole("button", { name: "Use" }).click();
    await expect(picker(first)).toHaveValue(otherFolder);
    await picker(first).selectOption(folder);
    await expect(picker(first)).toHaveValue(folder);
    await expect
      .poll(() => first.evaluate(() => window.localStorage.getItem("omp.app.root.folder")))
      .toBe(folder);

    // A second tab, from the link `omp-app <otherFolder>` prints: it opens on that folder, not the remembered one.
    const second = await openFolderLink(realApp, first, otherFolder, problems);
    await expect(picker(second)).toHaveValue(otherFolder);
    await expect(second.getByText("No sessions in this folder")).toBeVisible();
    // The folder left the address bar with the token, so a reload or a copied address asks for neither.
    await expect.poll(() => new URL(second.url()).hash).toBe("");
    expect(second.url()).not.toContain("folder=");
    expect(second.url()).not.toContain("token=");

    // A New chat in this tab runs in that folder.
    const composer = await startChat(second);
    await sendPrompt(composer, "ping");
    await expect(second.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    const home = join(dirname(realApp.agentDir), "home");
    await expect
      .poll(() => chatBuckets(realApp), { timeout: 30_000 })
      .toEqual([sessionBucketName(otherFolder, { home })]);

    // The folder is remembered as if picked by hand: the tab reloaded without it stays on that folder and its chat.
    await second.reload();
    await expect(picker(second)).toHaveValue(otherFolder);
    await expect(second.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(second);
    await second.screenshot({ path: join(screenshots, "launch-folder-param-light.png") });
    await second
      .locator('[data-app-folder-switcher="true"]')
      .screenshot({ path: join(screenshots, "launch-folder-param-selector-light.png") });

    expect(realApp.problems).toEqual([]);
    expect(problems).toEqual([]);
  },
);

realTest(
  "a launch link with a folder opens the app on it at 390 px, in the sessions drawer's picker",
  async ({ realApp }) => {
    const problems: string[] = [];
    const first = await realApp.open();
    const page = await openFolderLink(realApp, first, realApp.otherFolder, problems);
    await narrowTo(page);
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "true");
    await waitForFiniteAnimations(page);
    await expect(picker(page)).toHaveValue(realApp.otherFolder);
    await expect(picker(page)).toBeVisible();

    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "launch-folder-param-390.png") });
    await page
      .locator('[data-app-folder-switcher="true"]')
      .screenshot({ path: join(screenshots, "launch-folder-param-selector-390.png") });

    expect(realApp.problems).toEqual([]);
    expect(problems).toEqual([]);
  },
);
