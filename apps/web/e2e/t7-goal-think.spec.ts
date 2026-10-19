/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const THOUGHT = "Private scratchpad: compare the two parser designs before answering";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T7/goal-think-playground.tsx",
      "--outdir",
      "dist/t7-goal-think-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for goal cards.");
  writeFileSync(
    join(DIST_ROOT, "t7-goal-think-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t7-goal-think-playground/goal-think-playground.js"></script>
  </head>
  <body>
    <div id="t7-goal-think-playground-root"></div>
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
  await expect(page.getByTestId("t7-goal-think-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
}

async function expectCards(page: Page): Promise<void> {
  await openAllToolCards(page);
  await expect(page.getByTestId("t7-goal-card-goal-active")).toContainText(
    "12,000 of 50,000 tokens used",
  );
  await expect(page.getByTestId("t7-goal-card-goal-complete")).toContainText(
    "Complete · 61,500 of 80,000 tokens used · 18,500 tokens left",
  );
  await expect(page.getByTestId("t7-goal-card-goal-complete")).not.toContainText("Goal achieved");
  await expect(page.getByTestId("t7-think-card-think-running")).toContainText(
    "Recording private note…",
  );
  await expect(page.getByTestId("t7-think-card-think-recorded")).toContainText(
    "Private note recorded",
  );
  await expect(page.locator("body")).not.toContainText(THOUGHT);
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

test("renders goal and private think cards in light, dark and narrow layouts", async ({ page }) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/t7-goal-think-playground.html");
  await expectStyles(page);
  await expectCards(page);
  await page.screenshot({
    path: "../../.data/screenshots/t7.5-goal-think-light.png",
    fullPage: true,
  });

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/t7-goal-think-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expectStyles(darkPage);
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expectCards(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/t7.5-goal-think-dark.png",
    fullPage: true,
  });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await expectCards(page);
  await page.screenshot({
    path: "../../.data/screenshots/t7.5-goal-think-narrow.png",
    fullPage: true,
  });
  assertNoConsoleErrors();
});
