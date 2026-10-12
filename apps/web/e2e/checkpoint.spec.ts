/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T7/checkpoint-playground-entry.tsx",
      "--outdir",
      "dist/t7-checkpoint-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error(
      "The production build did not emit a stylesheet for the checkpoint playground.",
    );
  writeFileSync(
    join(DIST_ROOT, "t7-checkpoint-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t7-checkpoint-playground/checkpoint-playground-entry.js"></script>
  </head>
  <body>
    <div id="t7-checkpoint-playground-root"></div>
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
  await expect(page.getByTestId("t7-checkpoint-playground")).toHaveCSS(
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

async function expectCards(page: Page): Promise<void> {
  await expect(
    page.getByText("find why the cache misses after deploys", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Cache misses come from the key builder, not the eviction policy.", {
      exact: true,
    }),
  ).toBeVisible();
  await openAllToolCards(page);
  await expect(page.getByTestId("t7-rewind-report")).toContainText("drops the locale");
  await expect(page.getByTestId("tool-card-checkpoint-running")).toHaveAttribute(
    "data-phase",
    "running",
  );
  await expect(page.getByText(/"details"|"content"/).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText(/restored|host\.|P5|A1/)).toHaveCount(0);
}

test.beforeAll(buildPlaygroundPage);

test("renders a checkpoint, a rewind report and a running checkpoint in light/dark/narrow layouts", async ({
  page,
}) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/t7-checkpoint-playground.html");
  await expectStyles(page);
  await expectCards(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: "../../.data/screenshots/t7.4-checkpoint-light.png",
    fullPage: true,
  });

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/t7-checkpoint-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expectStyles(darkPage);
  await expectCards(darkPage);
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/t7.4-checkpoint-dark.png",
    fullPage: true,
  });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: "../../.data/screenshots/t7.4-checkpoint-narrow.png",
    fullPage: true,
  });
  assertNoConsoleErrors();
});
