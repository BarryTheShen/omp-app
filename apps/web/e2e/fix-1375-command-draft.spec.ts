import { mkdir, readdir, readFile } from "node:fs/promises";
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

/**
 * #1375: an admitted `!` or `$` command clears its draft, as an admitted prompt does. A refused line is a failed send
 * that the draft keeps. The admitted command must clear that record too, so the refusal does not come back after a
 * reload. Real omp; the failed sends are read from the app's own draft folders.
 */

const REFUSED =
  "Running a command without sending its output to the model is not available in this version of omp.";
// The composer saves ten seconds after its last change; the poll allows that plus the save.
const SAVED = { timeout: 45_000 } as const;

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

function composerError(page: Page): Locator {
  return page.locator('[data-composer-error="true"]');
}

/** The failed sends stored in the app's draft folders, counted over every draft file. */
async function storedFailedSends(appDataDir: string): Promise<number> {
  let total = 0;
  for (const folder of ["threads", "folders"] as const) {
    const dir = join(appDataDir, "drafts", folder);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      let value: unknown;
      try {
        value = JSON.parse(await readFile(join(dir, file), "utf8"));
      } catch {
        // A file that is being written is read on the next poll.
        continue;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "draft" &&
        "failedSends" in value &&
        Array.isArray(value.failedSends)
      ) {
        total += value.failedSends.length;
      }
    }
  }
  return total;
}

/**
 * Sends a prompt so the chat has messages, refuses a `!!` line (which leaves a failed send in the chat's own draft),
 * then admits a `!` command in its place. Returns the composer once the command's output is on screen and the draft's
 * failed sends are cleared.
 */
async function refuseThenAdmit(page: Page, appDataDir: string): Promise<Locator> {
  const input = await startChat(page);
  await sendPrompt(input, "chat seed");
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });
  await sendPrompt(input, "!!echo excluded-out");
  await expect(composerError(page)).toHaveText(REFUSED, { timeout: 30_000 });
  await expect(input).toHaveValue("!!echo excluded-out");
  // The refusal is a failed send, and the chat's draft stores it.
  await expect.poll(() => storedFailedSends(appDataDir), SAVED).toBe(1);

  await sendPrompt(input, "!echo bash-line-ok");
  await expect(page.getByText("bash-line-ok", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(input).toHaveValue("");
  // An admitted command clears the draft and its failed sends, as an admitted prompt does.
  await expect.poll(() => storedFailedSends(appDataDir), SAVED).toBe(0);
  return input;
}

realTest(
  "#1375: an admitted `!` command clears its draft, so the refusal from before does not come back after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light"));
      },
    });
    await refuseThenAdmit(page, realApp.appDataDir);

    await page.reload();
    // The reloaded chat's conversation is on screen before the composer is checked or captured.
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    const input = composer(page);
    await expect(input).toBeVisible({ timeout: 60_000 });
    await expect(input).toHaveValue("");
    await expect(composerError(page)).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1375-cleared-light.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1375-cleared-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1375: the same flow in dark theme leaves no refusal in the composer after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
      },
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await refuseThenAdmit(page, realApp.appDataDir);

    await page.reload();
    // The reloaded chat's conversation is on screen before the composer is checked or captured.
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    const input = composer(page);
    await expect(input).toBeVisible({ timeout: 60_000 });
    await expect(input).toHaveValue("");
    await expect(composerError(page)).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1375-cleared-dark.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);
