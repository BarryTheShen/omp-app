import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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

const NOTE = "trigger-notes.md";

/**
 * A cancel that an Escape wrongly sends reaches the page within a second or two (the bash card turns to
 * Cancelled), so the turn is checked again after this wait, not the moment the list closes.
 */
const SETTLE_MS = 3_000;

/** omp's commands above the composer: the list that the first Escape closes. */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/** The file suggestions above the composer, for an `@` mention. */
function fileList(page: Page): Locator {
  return page.getByRole("listbox", { name: "File suggestions" });
}

/** Shown while a turn runs; pressing it stops the turn. */
function stopButton(page: Page): Locator {
  return page.getByRole("button", { name: "Stop generating" });
}

/** The bash card of the long turn: its line reads "bash: Running" while the command is in flight. */
function bashCard(page: Page, status: "Running" | "Cancelled"): Locator {
  return page.getByRole("button", { name: `bash: ${status}`, exact: true });
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/**
 * Starts a turn that runs for a minute: the fake model answers "long_probe_child" with a shell command
 * that sleeps 60 seconds. Returns once that command is in flight.
 */
async function startLongTurn(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await sendPrompt(composer, "please run long_probe_child");
  await expect(stopButton(page)).toBeVisible({ timeout: 60_000 });
  await expect(bashCard(page, "Running")).toBeVisible({ timeout: 60_000 });
  return composer;
}

/** Makes the chat's folder a git repository holding one note, so the `@` list has a file to offer. */
async function folderWithNote(folder: string): Promise<void> {
  execFileSync("git", ["init", "-q", folder]);
  await writeFile(join(folder, NOTE), "notes\n");
}

realTest(
  "#1355: with a turn running, Escape closes the slash list and the turn keeps running; the next Escape stops it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startLongTurn(page);
    await composer.pressSequentially("/us");
    await expect(commandList(page).getByRole("option", { name: /^\/usage/ })).toBeVisible({
      timeout: 30_000,
    });

    await composer.press("Escape");
    await expect(commandList(page)).toBeHidden();
    await page.waitForTimeout(SETTLE_MS);
    // The list took the key, so the turn is still running: Stop stays and the bash command is still in flight.
    await expect(stopButton(page)).toBeVisible();
    await expect(bashCard(page, "Running")).toBeVisible();
    await expect(composer).toHaveValue("/us");
    await expect(composer).toBeFocused();
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1355-list-closed-light.png") });

    // No list is open now, so Escape keeps its meaning: it stops the turn and the text stays.
    await composer.press("Escape");
    await expect(stopButton(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(bashCard(page, "Cancelled")).toBeVisible();
    await expect(composer).toHaveValue("/us");
    await expect(commandList(page)).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toHaveValue("/us");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1355-stopped-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1355: with a turn running, Escape closes the file list in dark theme and the turn keeps running",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    await folderWithNote(realApp.folder);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const composer = await startLongTurn(page);
    await composer.pressSequentially("see @trigger-n");
    await expect(fileList(page)).toBeVisible();
    await expect(page.getByText(NOTE)).toBeVisible({ timeout: 30_000 });

    await composer.press("Escape");
    await expect(fileList(page)).toBeHidden();
    await page.waitForTimeout(SETTLE_MS);
    await expect(stopButton(page)).toBeVisible();
    await expect(bashCard(page, "Running")).toBeVisible();
    await expect(composer).toHaveValue("see @trigger-n");
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1355-file-list-closed-dark.png") });

    await composer.press("Escape");
    await expect(stopButton(page)).toHaveCount(0, { timeout: 30_000 });
    expect(realApp.problems).toEqual([]);
  },
);
