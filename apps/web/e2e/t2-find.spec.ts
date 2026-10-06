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
      "src/modules/T2/find-playground.tsx",
      "--outdir",
      "dist/t2-find-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the find playground.");
  writeFileSync(
    join(DIST_ROOT, "t2-find-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t2-find-playground/find-playground.js"></script>
  </head>
  <body>
    <div id="t2-find-playground-root"></div>
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
  await expect(page.getByTestId("t2-find-playground")).toHaveCSS(
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
  await expect(page.getByText("retry budget in src · 2 hits")).toBeVisible();
  await expect(page.getByText("lines 10–20")).toBeVisible();
  await expect(page.getByText("90%")).toBeVisible();
  await expect(page.getByText("Showing 20 of 34")).toBeVisible();
  await expect(page.getByText("No matches.")).toBeVisible();
  await expect(page.getByTestId("tool-card-find-running")).toHaveAttribute("data-phase", "running");
  await expect(page.getByText(/"hits"/)).toHaveCount(0);
}

test.beforeAll(buildPlaygroundPage);

test("renders scored find hits, cut lists, no matches and running in light/dark/narrow layouts", async ({
  page,
}) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/t2-find-playground.html");
  await expectStyles(page);
  await expectCards(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/t2.4-find-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/t2-find-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expectStyles(darkPage);
  await expectCards(darkPage);
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({ path: "../../.data/screenshots/t2.4-find-dark.png", fullPage: true });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/t2.4-find-narrow.png", fullPage: true });
  assertNoConsoleErrors();
});
