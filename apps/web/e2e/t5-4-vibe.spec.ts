/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOTS = join(APP_ROOT, "../../.data/screenshots");
const PAGE = "/t5-4-vibe-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T5/vibe-playground.tsx",
      "--outdir",
      "dist/t5-4-vibe-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the vibe playground.");
  writeFileSync(
    join(DIST_ROOT, "t5-4-vibe-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t5-4-vibe-playground/vibe-playground.js"></script>
  </head>
  <body>
    <div id="t5-4-vibe-playground-root"></div>
  </body>
</html>
`,
  );
}

test.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    mkdirSync(SCREENSHOTS, { recursive: true });
    buildPlaygroundPage();
  }),
);

test("the four vibe cards show omp's source-derived results in light, dark and narrow layouts", async ({
  page,
}) => {
  await page.goto(PAGE);
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(page.getByTestId("t5-vibe-playground")).toBeVisible();
  await expect(page.getByTestId("t5-vibe-send-card")).toHaveCount(4);
  await expect(page.getByTestId("t5-vibe-list-card")).toHaveCount(2);
  await expect(page.getByTestId("t5-vibe-wait-card")).toHaveCount(5);
  await expect(page.getByTestId("t5-vibe-kill-card")).toHaveCount(3);
  await openAllToolCards(page);
  await expect(page.getByText("2 vibe workers · 1 killed", { exact: true })).toBeVisible();
  await expect(page.getByText("Turn started on fast-1", { exact: true })).toBeVisible();
  await expect(
    page.getByText("No turn settled before the wait ran out", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Killed fast-1", { exact: true })).toBeVisible();
  await expect(page.getByText("Killed (1): fast-3")).toBeVisible();
  await expect(page.getByText("Waiting for worker turns").first()).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOTS, "t5-4-vibe-light.png"), fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto(PAGE);
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByTestId("t5-vibe-playground")).toBeVisible();
  await openAllToolCards(darkPage);
  await darkPage.screenshot({ path: join(SCREENSHOTS, "t5-4-vibe-dark.png"), fullPage: true });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("t5-vibe-playground")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(overflow).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(SCREENSHOTS, "t5-4-vibe-narrow.png"), fullPage: true });
});
