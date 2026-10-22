/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

// #2334: an approval prompt's title keeps its lines and indentation. Real-omp approvals reach the app only through
// extension and MCP tools, so this uses the app's select dialog with omp's approval text as the title.
const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SHOTS = join(APP_ROOT, "../../.data/screenshots");
const PAGE = "/approval-title.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U4/dialogs/approval-title-playground.tsx",
      "--outfile",
      "dist/approval-title-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the approval title page.");
  writeFileSync(
    join(DIST_ROOT, "approval-title.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp approval title</title>
  </head>
  <body>
    <div id="approval-title-root"></div>
    <script type="module" src="/approval-title-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

/** Opens the approval, checks its title keeps the lines and indentation omp sent, and captures it. */
async function expectLinesKept(page: Page, name: string): Promise<void> {
  await page.locator("#open-approval").click();
  const title = page.getByTestId("dialog-frame").locator("h2");
  await expect(title).toBeVisible();
  await expect(title).toHaveCSS("white-space", "pre-wrap");
  const lines = await title.evaluate((node) => (node as HTMLElement).innerText.split("\n"));
  expect(lines).toContain("Arguments:");
  expect(lines).toContain('  "path": "/tmp/omp-approval-probe-2334.txt",');
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name), fullPage: true });
}

test("an approval's title keeps its lines and indentation, light at 1280 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE);
  await expectLinesKept(page, "fix-2334-approval-light-1280.png");
});

test("an approval's title keeps its lines and indentation, dark at 1280 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectLinesKept(page, "fix-2334-approval-dark-1280.png");
});

test("an approval's title keeps its lines and indentation, at 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PAGE);
  await expectLinesKept(page, "fix-2334-approval-narrow-390.png");
});
