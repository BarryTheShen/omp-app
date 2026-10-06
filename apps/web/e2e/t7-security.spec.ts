/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T7/security-playground.tsx",
      "--outdir",
      "dist/t7-security-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for security cards.");
  writeFileSync(
    join(DIST_ROOT, "t7-security-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t7-security-playground/security-playground.js"></script>
  </head>
  <body>
    <div id="t7-security-playground-root"></div>
  </body>
</html>
`,
  );
}

function failOnConsoleErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

async function expectStyles(page: Page): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(page.getByTestId("t7-security-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
}

async function expectCards(page: Page): Promise<void> {
  await expect(page.getByTestId("t7-security-card-security-findings")).toContainText("1 critical");
  await expect(page.getByTestId("t7-security-card-security-findings")).toContainText("5 medium");
  await expect(page.getByTestId("t7-security-card-security-clean")).toContainText(
    "Completed · 0 findings",
  );
  await expect(page.getByTestId("t7-security-card-security-validation")).toContainText(
    "Validation failed",
  );
  await expect(page.getByTestId("t7-security-card-security-running")).toContainText(
    "Plan a scan of src/, packages/server/",
  );
  await expect(page.locator("body")).not.toContainText('"details"');
  await expect(page.locator("body")).not.toContainText('"action"');
}

test.beforeAll(buildPlaygroundPage);

test("renders security scan cards in light, dark and narrow layouts", async ({ page }) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/t7-security-playground.html");
  await expectStyles(page);
  await expectCards(page);
  await page.screenshot({
    path: "../../.data/screenshots/t7.6-security-light.png",
    fullPage: true,
  });

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/t7-security-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expectStyles(darkPage);
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expectCards(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/t7.6-security-dark.png",
    fullPage: true,
  });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await expectCards(page);
  await page.screenshot({
    path: "../../.data/screenshots/t7.6-security-narrow.png",
    fullPage: true,
  });
  assertNoConsoleErrors();
});
