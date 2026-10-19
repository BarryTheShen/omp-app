/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOTS = join(APP_ROOT, "../../.data/screenshots");
const playground = "/i3-2-memory-playground.html";

function buildPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/I3/memory/playground.tsx",
      "--outfile",
      "dist/i3-2-memory-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The app build did not emit the I3.2 stylesheet.");
  mkdirSync(SCREENSHOTS, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "i3-2-memory-playground.html"),
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><link rel="stylesheet" href="/assets/${css}"/><script>if(location.search.includes("dark"))document.documentElement.classList.add("dark");</script><title>omp memory</title></head><body><div id="i3-2-memory-playground-root"></div><script type="module" src="/i3-2-memory-playground.js"></script></body></html>`,
  );
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlayground));

async function assertStyledTheme(page: Page): Promise<void> {
  const colors = await page.getByRole("button", { name: "This project" }).evaluate((button) => {
    const tokenProbe = document.createElement("span");
    tokenProbe.style.backgroundColor = "var(--primary)";
    document.body.append(tokenProbe);
    const tokenColor = getComputedStyle(tokenProbe).backgroundColor;
    const buttonColor = getComputedStyle(button).backgroundColor;
    tokenProbe.remove();
    return { tokenColor, buttonColor };
  });
  expect(colors.buttonColor).toBe(colors.tokenColor);
}

async function exerciseConflictAndError(
  page: Page,
  screenshotPrefix: string,
  dark = false,
): Promise<void> {
  await page.goto(dark ? `${playground}?dark` : playground);
  await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  if (dark) await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
  await assertStyledTheme(page);
  await page.getByRole("option", { name: /Memory item/ }).click();
  const editor = page.getByRole("textbox", { name: "Memory content" });
  await editor.fill("Updated memory draft.");
  await page.getByRole("button", { name: "Save memory" }).click();
  await expect(page.getByText("Memory changed elsewhere.", { exact: true })).toBeVisible();
  await page.screenshot({
    path: join(SCREENSHOTS, `i3.2-memory-${screenshotPrefix}-conflict.png`),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Keep my draft" }).click();
  const save = page.getByRole("button", { name: "Save memory" });
  await save.click();
  await expect(editor).toHaveValue("Updated memory draft.");
  await expect(save).toBeDisabled();
  await expect(page.getByText("Memory changed elsewhere.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(editor).toHaveValue("Updated memory draft.");
  await expect(save).toBeDisabled();

  await page.getByRole("button", { name: "Diagnose memory" }).click();
  await expect(page.getByText("Memory diagnostics timed out.", { exact: true })).toBeVisible();
  await page.screenshot({
    path: join(SCREENSHOTS, `i3.2-memory-${screenshotPrefix}-error.png`),
    fullPage: true,
  });
}

test.describe("I3.2 memory control center", () => {
  test("preserves drafts, confirms clear, and shows command errors", async ({ page, browser }) => {
    await exerciseConflictAndError(page, "light");
    await page.getByRole("button", { name: "Queue consolidation" }).click();
    await expect(page.getByText("Memory consolidation enqueued.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Show memory stats" }).click();
    await expect(page.getByText("Memory statistics are ready.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Clear memory" }).click();
    const confirmation = page.getByRole("dialog");
    await expect(confirmation).toContainText("Clear memory?");
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.locator("#i3-2-memory-playground-root")).toHaveAttribute(
      "data-clear-calls",
      "0",
    );
    await expect(page.getByText("Clear memory completed.", { exact: false })).toHaveCount(0);

    await page.getByRole("button", { name: "Clear memory" }).click();
    const confirmClear = page.getByRole("dialog");
    await confirmClear.getByRole("button", { name: "Clear memory" }).click();
    await expect(page.getByText("Clear memory completed.", { exact: true })).toBeVisible();
    await expect(page.locator("#i3-2-memory-playground-root")).toHaveAttribute(
      "data-clear-calls",
      "1",
    );

    const dark = await browser.newPage();
    await dark.addInitScript(() => document.documentElement.classList.add("dark"));
    await exerciseConflictAndError(dark, "dark", true);

    const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await exerciseConflictAndError(narrow, "390");
    await expect
      .poll(() => narrow.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(390);
  });
});
