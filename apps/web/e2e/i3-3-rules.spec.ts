/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOTS = join(APP_ROOT, "../../.data/screenshots");
const playground = "/i3-3-rules-playground.html";

function buildPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/I3/rules/playground.tsx",
      "--outfile",
      "dist/i3-3-rules-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The app build did not emit the I3.3 stylesheet.");
  mkdirSync(SCREENSHOTS, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "i3-3-rules-playground.html"),
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><link rel="stylesheet" href="/assets/${css}"/><script>if(location.search.includes("dark"))document.documentElement.classList.add("dark");</script><title>omp rules</title></head><body><div id="i3-3-rules-playground-root"></div><script type="module" src="/i3-3-rules-playground.js"></script></body></html>`,
  );
}

test.beforeAll(() => buildPlayground());

async function assertStyledTheme(page: Page): Promise<void> {
  const colors = await page.getByRole("button", { name: "This project" }).evaluate((button) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--primary)";
    document.body.append(probe);
    const tokenColor = getComputedStyle(probe).backgroundColor;
    const buttonColor = getComputedStyle(button).backgroundColor;
    probe.remove();
    return { tokenColor, buttonColor };
  });
  expect(colors.buttonColor).toBe(colors.tokenColor);
}

async function exerciseRules(page: Page, prefix: string, dark = false): Promise<void> {
  if (dark) await page.addInitScript(() => document.documentElement.classList.add("dark"));
  await page.goto(dark ? `${playground}?dark` : playground);
  await expect(page.getByRole("heading", { name: "Rules" }).first()).toBeVisible();
  if (dark) await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
  await assertStyledTheme(page);
  await page.getByRole("option", { name: /Release notes/ }).click();
  const editor = page.getByRole("textbox", { name: "Rule content" });
  await editor.fill("Updated release rule.");
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText("This rule changed elsewhere.", { exact: false })).toBeVisible();
  await page.screenshot({
    path: join(SCREENSHOTS, `i3.3-rules-${prefix}-conflict.png`),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Keep my draft" }).click();
  await expect(page.getByRole("button", { name: "Save rule" })).toBeDisabled();
  await page.getByRole("button", { name: "Overwrite newer rule" }).click();
  const overwrite = page.getByRole("dialog");
  await expect(overwrite).toContainText("Overwrite the newer rule?");
  await overwrite.getByRole("button", { name: "Overwrite rule" }).click();
  await expect(overwrite).toHaveCount(0);
  await expect(editor).toHaveValue("Updated release rule.");
  await expect(page.getByRole("button", { name: "Save rule" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Search rules" }).fill("release");
  await expect(page.getByRole("option", { name: /Release notes/ })).toBeVisible();
  await page.getByRole("button", { name: "Delete rule" }).click();
  const confirmation = page.getByRole("dialog");
  await expect(confirmation).toContainText("Delete this rule?");
  await confirmation.getByRole("button", { name: "Delete rule", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page.getByText("Rule could not be deleted.", { exact: true })).toBeVisible();
  await page.screenshot({
    path: join(SCREENSHOTS, `i3.3-rules-${prefix}-error.png`),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  const retryConfirmation = page.getByRole("dialog");
  await expect(retryConfirmation).toContainText("Delete this rule?");
  await retryConfirmation.getByRole("button", { name: "Delete rule", exact: true }).click();
  await expect(retryConfirmation).toHaveCount(0);
  await expect(page.getByText("No rules found")).toBeVisible();
}

test("I3.3 rules edits preserve drafts across conflict and report action errors", async ({
  page,
  browser,
}) => {
  await exerciseRules(page, "light");
  const dark = await browser.newPage();
  await exerciseRules(dark, "dark", true);
  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await exerciseRules(narrow, "390");
  await expect
    .poll(() => narrow.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
});
