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
      "src/modules/P3/branch-picker/playground.tsx",
      "--outfile",
      "dist/p3-branch-picker.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for P3 branch picker.");
  writeFileSync(
    join(DIST_ROOT, "p3-branch-picker.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>P3 branch picker</title>
  </head>
  <body>
    <div id="p3-branch-picker-playground-root"></div>
    <script type="module" src="/p3-branch-picker.js"></script>
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

test("renders branch count/actions with loaded styles in light mode", async ({ page }) => {
  await page.goto("/p3-branch-picker.html");
  await expect(page.getByRole("status", { name: "Branch position" })).toContainText("2 / 2");
  await expect(page.getByRole("button", { name: "Previous branch" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next branch" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy message" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Edit message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate message" })).toBeVisible();
  expect(await page.locator('link[rel="stylesheet"]').count()).toBeGreaterThan(0);
  const screenshot = await page.screenshot({
    path: "../../.data/screenshots/p3-2-light.png",
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});

test("starts dark and keeps branch controls visible", async ({ page }) => {
  await page.goto("/p3-branch-picker.html");
  await page.locator("html").evaluate((element) => element.classList.add("dark"));
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("status", { name: "Branch position" })).toContainText("2 / 2");
  const screenshot = await page.screenshot({
    path: "../../.data/screenshots/p3-2-dark.png",
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});

test("keeps the branch stepper reachable at narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/p3-branch-picker.html");
  await expect(page.getByRole("status", { name: "Branch position" })).toBeVisible();
  const screenshot = await page.screenshot({
    path: "../../.data/screenshots/p3-2-narrow.png",
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});
