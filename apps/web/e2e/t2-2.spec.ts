/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "e2e/t2-2-playground.tsx",
      "--outfile",
      "dist/t2-grep-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the T2 grep playground.");
  writeFileSync(
    join(DIST_ROOT, "t2-grep-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>T2 grep</title>
  </head>
  <body>
    <div id="t2-grep-playground-root"></div>
    <script type="module" src="/t2-grep-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("renders grouped grep matches and style-linked results in light mode", async ({ page }) => {
  await page.goto("/t2-grep-playground.html");
  await openAllToolCards(page);
  await expect(page.getByRole("heading", { name: "Grep results" })).toBeVisible();
  await expect(page.getByLabel("Grep matches by file")).toContainText("src/main.tsx");
  await expect(page.locator("[data-t2-grep-lines]")).toContainText("TODO: wire");
  await expect(page.locator("[data-t2-grep-lines]")).toContainText("TODO: remove");
  await expect(page.getByLabel("Grep matches by file")).toContainText("2 matches");
  await expect(page.getByText("case-sensitive")).toBeVisible();
  await expect(page.getByText("TODO in src · 3 matches")).toBeVisible();
  expect(await page.locator('link[rel="stylesheet"]').count()).toBeGreaterThan(0);
  const screenshot = await page.screenshot({
    path: "../../.data/screenshots/t2-2-light.png",
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});

test("starts dark and keeps grouped matches readable", async ({ page }) => {
  await page.goto("/t2-grep-playground.html");
  await page.locator("html").evaluate((element) => element.classList.add("dark"));
  await expect(page.locator("html")).toHaveClass(/dark/);
  await openAllToolCards(page);
  await expect(page.getByLabel("Grep matches by file")).toContainText("src/utils.ts");
  const screenshot = await page.screenshot({
    path: "../../.data/screenshots/t2-2-dark.png",
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});

test("keeps file groups and line matches visible at narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/t2-grep-playground.html");
  await openAllToolCards(page);
  await expect(page.getByLabel("Grep matches by file")).toContainText("src/main.tsx");
  await expect(page.getByRole("link", { name: "src/utils.ts" })).toBeVisible();
  const screenshot = await page.screenshot({
    path: "../../.data/screenshots/t2-2-narrow.png",
    fullPage: true,
  });
  expect(screenshot.byteLength).toBeGreaterThan(1_000);
});
