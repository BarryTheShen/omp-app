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
      "src/modules/T2/late-diagnostics-playground.tsx",
      "--outdir",
      "dist/t2-late-diagnostics-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error(
      "The production build did not emit a stylesheet for the late diagnostics playground.",
    );
  writeFileSync(
    join(DIST_ROOT, "t2-late-diagnostics-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t2-late-diagnostics-playground/late-diagnostics-playground.js"></script>
  </head>
  <body>
    <div id="t2-late-diagnostics-playground-root"></div>
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
  await expect(page.getByTestId("t2-late-diagnostics-playground")).toHaveCSS(
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
  await openAllToolCards(page);
  // The attached message: omp's summary per file, one collapsed line for the card.
  await expect(page.getByText("2 files: 1 error(s); no issues")).toBeVisible();
  // Exact matches: the card's raw copy holds the same words in a closed <details>, which must not count here.
  await expect(
    page.getByText("cart.ts:41:9 [error] [typescript] Property 'total' does not exist (2339)", {
      exact: true,
    }),
  ).toBeVisible();
  // Five of the file's eight lines are listed; the seventh warning waits behind "Show more".
  const seventh = "cart.ts:16:3 [warning] [typescript] Unused variable number 7 (6133)";
  await expect(page.getByText(seventh, { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Show 3 more in this file" }).click();
  await expect(page.getByText(seventh, { exact: true })).toBeVisible();
  // Only the file that errored is marked as such.
  await expect(page.locator('[data-errored="true"]')).toHaveCount(1);
  // Explicit states: no files, and a message that could not be read.
  await expect(page.getByText("No new diagnostics")).toBeVisible();
  await expect(page.getByText("The diagnostics could not be read").first()).toBeVisible();
  // Only the two messages with no tool call say they came after the edit or write.
  await expect(page.getByText("Reported after the edit or write finished.")).toHaveCount(2);
  // omp's lines are text: the markup in one is shown as written, never rendered.
  await expect(
    page.getByText("notes.md:4:1 [hint] <b>not bold</b> & kept as text", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("b", { hasText: "not bold" })).toHaveCount(0);
}

test.beforeAll(buildPlaygroundPage);

test("renders omp's file summaries and lines, the bound, explicit empty and unreadable states, and safe text in light/dark/narrow layouts", async ({
  page,
}) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/t2-late-diagnostics-playground.html");
  await expectStyles(page);
  await expectCards(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: "../../.data/screenshots/t2.6-late-light.png",
    fullPage: true,
  });

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/t2-late-diagnostics-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expectStyles(darkPage);
  await expectCards(darkPage);
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/t2.6-late-dark.png",
    fullPage: true,
  });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: "../../.data/screenshots/t2.6-late-narrow.png",
    fullPage: true,
  });
  assertNoConsoleErrors();
});
