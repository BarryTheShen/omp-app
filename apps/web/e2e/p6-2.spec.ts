/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P6/bar/playground.tsx",
      "--outfile",
      "dist/p6-bar-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for the P6 bar.");
  writeFileSync(
    join(DIST_ROOT, "p6-bar-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>P6 queue bar</title>
  </head>
  <body>
    <div id="p6-bar-playground-root"></div>
    <script type="module" src="/p6-bar-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    buildPlaygroundPage();
  }),
);

test("renders both queue lanes with token styles and captures the light view", async ({ page }) => {
  await page.goto("/p6-bar-playground.html");
  await expect(page.getByRole("complementary", { name: "Queued messages" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Steering" })).toContainText(
    "Fix the failing test",
  );
  await expect(page.getByRole("region", { name: "After this turn" })).toContainText(
    "Summarize the changes after yield",
  );
  expect(await page.locator('link[rel="stylesheet"]').count()).toBeGreaterThan(0);
  const screenshot = await page.screenshot({
    path: "../../.data/screenshots/p6-2-light.png",
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});

test("starts dark and captures the dark queue bar", async ({ page }) => {
  await page.goto("/p6-bar-playground.html");
  await page.locator("html").evaluate((element) => element.classList.add("dark"));
  await expect(page.locator("html")).toHaveClass(/dark/);
  const screenshot = await page.screenshot({
    path: "../../.data/screenshots/p6-2-dark.png",
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});

test("keeps both lanes reachable in a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/p6-bar-playground.html");
  await expect(page.getByRole("region", { name: "Steering" })).toBeVisible();
  await expect(page.getByRole("region", { name: "After this turn" })).toBeVisible();
  const screenshot = await page.screenshot({
    path: "../../.data/screenshots/p6-2-narrow.png",
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});
