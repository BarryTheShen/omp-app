/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

const REGION_NAME = "Session and workspace status";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/N1/status/status-playground.tsx",
      "--outdir",
      "dist/n1-4-status-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error(
      "The production build did not emit a stylesheet for the status bar playground.",
    );
  writeFileSync(
    join(DIST_ROOT, "n1-4-status-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/n1-4-status-playground/status-playground.js"></script>
  </head>
  <body>
    <div id="n1-4-status-playground-root"></div>
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
  await expect(page.getByTestId("n1-4-status-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
}

async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

/** A segment is found by its id; its shown text is the value inside it (the label is read by screen readers). */
function segment(page: Page, id: string): Locator {
  return page.locator(`[data-segment="${id}"]`);
}

function shownValue(page: Page, id: string): Locator {
  return segment(page, id).locator("[data-segment-value]");
}

async function expectSegments(page: Page): Promise<void> {
  const bar = page.getByRole("region", { name: REGION_NAME });
  await expect(bar).toBeVisible();
  // The bar draws the folder's name and the branch; the server and the session are in the folder's tooltip.
  await expect(shownValue(page, "N2.path")).toHaveText("app");
  await expect(segment(page, "N2.path")).toHaveAttribute("title", /Workspace folder: ~\/code\/app/);
  await expect(segment(page, "N2.path")).toHaveAttribute("title", /Server ID: devbox/);
  await expect(shownValue(page, "N2.git")).toHaveText("main");
  // Not drawn: the host, the pull request, the clock and the active time stay out of the bar.
  for (const id of ["N2.hostname", "N2.pr", "N2.time", "N2.time-spent"]) {
    await expect(segment(page, id)).toHaveCount(0);
  }
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

test("renders the folder, the branch and the tooltip, and draws nothing else, in light, dark and narrow layouts", async ({
  page,
}) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/n1-4-status-playground.html");
  await expectStyles(page);
  await expectSegments(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/n1-4-status-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/n1-4-status-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expectStyles(darkPage);
  await expectSegments(darkPage);
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/n1-4-status-dark.png",
    fullPage: true,
  });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await expectSegments(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "no sideways scroll at 390 px").toBeLessThanOrEqual(0);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/n1-4-status-narrow.png", fullPage: true });
  assertNoConsoleErrors();
});
