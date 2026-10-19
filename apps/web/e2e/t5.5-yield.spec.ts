/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PLAYGROUND = "/t5-yield-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T5/yield-playground.tsx",
      "--outdir",
      "dist/t5-yield-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for T5 yield.");
  writeFileSync(
    join(DIST_ROOT, "t5-yield-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div id="t5-yield-playground-root"></div>
    <script type="module" src="/t5-yield-playground/yield-playground.js"></script>
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

test("renders the yield outcomes with their output, sections and reasons in light, dark and narrow", async ({
  page,
}) => {
  await page.goto(PLAYGROUND);
  await expect(page.getByTestId("t5-yield-playground")).toBeVisible();
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  // A finished submission starts as one line: open the cards so their output and reasons are on the page.
  await openAllToolCards(page);
  await expect(page.getByTestId("t5-yield-output").first()).toContainText("Three findings");
  await expect(page.getByText("1 section submitted")).toBeVisible();
  await expect(page.getByTestId("tool-card-yield-aborted")).toHaveAttribute("data-phase", "error");
  await expect(page.getByTestId("tool-card-yield-schema-error")).toHaveAttribute(
    "data-phase",
    "error",
  );
  await expect(page.getByText(/Showing 12 of 30 lines/)).toBeVisible();
  await page.screenshot({ path: "../../.data/screenshots/t5.5-yield-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto(PLAYGROUND);
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByTestId("t5-yield-playground")).toBeVisible();
  await openAllToolCards(darkPage);
  await expect(darkPage.getByText("The result is invalid; raw output is available.")).toBeVisible();
  await darkPage.screenshot({
    path: "../../.data/screenshots/t5.5-yield-dark.png",
    fullPage: true,
  });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("t5-yield-playground")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "../../.data/screenshots/t5.5-yield-narrow.png", fullPage: true });
});
