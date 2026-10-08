import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat } from "./real-omp";

const NOTE = "trigger-notes.md";

/**
 * Makes the chat's folder a git repository holding one note. The fixture folder sits under the
 * repository's git-ignored `.data/`, where git's ignore rules hide every file from the file search.
 * A folder that is its own repository lists its files, as a project folder does.
 */
async function folderWithNote(folder: string): Promise<void> {
  execFileSync("git", ["init", "-q", folder]);
  await writeFile(join(folder, NOTE), "notes\n");
}

/** The shell's background is the `--background` token (bg-background on the shell root). */
async function expectTokenBackground(page: Page): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((shell) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      context.fillStyle = "#000000";
      context.fillStyle = color;
      return context.fillStyle;
    };
    const background = getComputedStyle(shell).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return {
      normalizedBackground: normalize(background),
      normalizedToken: normalize(token),
      token,
    };
  });
  expect(colors.token).not.toBe("");
  expect(colors.normalizedBackground).toBe(colors.normalizedToken);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

realTest(
  "@ lists the open folder's files, and inserting one puts a mention into the draft",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await folderWithNote(realApp.folder);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("see @trigger-n");
    await expect(page.getByRole("listbox", { name: "File suggestions" })).toBeVisible();
    await expect(page.getByText(NOTE)).toBeVisible({ timeout: 30_000 });
    await composer.press("ArrowDown");
    await composer.press("Enter");
    await expect(composer).toHaveValue(`see @${NOTE} `);
  },
);

realTest(": lists emoji, and inserting one writes the character", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  const composer = await startChat(page);
  await composer.pressSequentially("say :smil");
  await expect(page.getByRole("listbox", { name: "Emoji suggestions" })).toBeVisible();
  await page.getByText(/:smile:/).click();
  await expect(composer).toHaveValue("say 😄 ");
});

realTest(
  "the trigger list follows the keyboard: arrows move, Enter inserts, Escape closes and keeps focus in the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("pick :sm");
    await expect(page.getByRole("listbox", { name: "Emoji suggestions" })).toBeVisible();
    await composer.press("ArrowDown");
    const first = await page.locator("[data-highlighted]").textContent();
    await composer.press("ArrowDown");
    const second = await page.locator("[data-highlighted]").textContent();
    expect(second).not.toBe(first);
    await composer.press("Enter");
    await expect(composer).toHaveValue(/^pick \S/);
    await expect(page.getByRole("listbox", { name: "Emoji suggestions" })).toHaveCount(0);

    await composer.fill("");
    await composer.pressSequentially("keep :sm");
    await expect(page.getByRole("listbox", { name: "Emoji suggestions" })).toBeVisible();
    await composer.press("Escape");
    await expect(page.getByRole("listbox", { name: "Emoji suggestions" })).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("keep :sm");
  },
);

realTest(
  "a # typed into prose leaves no list open, and the typed text stays",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("ticket #12 is open");
    await expect(composer).toHaveValue("ticket #12 is open");
    // Give the GitHub search for "12" time to answer, then check the list is still closed.
    await page.waitForTimeout(1_000);
    await expect(page.getByRole("listbox", { name: "GitHub suggestions" })).toHaveCount(0);
  },
);

realTest("an open file list reads in light and at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  await folderWithNote(realApp.folder);
  const page = await realApp.open();
  const composer = await startChat(page);
  await composer.pressSequentially("see @trigger-n");
  await expect(page.getByText(NOTE)).toBeVisible({ timeout: 30_000 });
  await expectTokenBackground(page);
  await page.screenshot({ path: join(screenshots, "app-composer-light.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText(NOTE)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: join(screenshots, "app-composer-narrow.png"), fullPage: true });
});

realTest("an open file list reads in dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  await folderWithNote(realApp.folder);
  // System is the default theme, so a dark browser makes the app dark, as the theme spec checks.
  const page = await realApp.open({
    beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
  });
  const composer = await startChat(page);
  await composer.pressSequentially("see @trigger-n");
  await expect(page.getByText(NOTE)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectTokenBackground(page);
  await page.screenshot({ path: join(screenshots, "app-composer-dark.png"), fullPage: true });
});
