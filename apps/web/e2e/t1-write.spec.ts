/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T1/write-playground.tsx",
      "--outdir",
      "dist/t1-write-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the write playground.");
  writeFileSync(
    join(DIST_ROOT, "t1-write-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t1-write-playground/write-playground.js"></script>
  </head>
  <body>
    <div id="t1-write-playground-root"></div>
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

test("renders streaming, executable, SVG-safe and error write states in light/dark/narrow layouts", async ({
  page,
}) => {
  await page.goto("/t1-write-playground.html");
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(page.getByTestId("t1-write-playground")).toBeVisible();
  await expect(page.getByTestId("t1-write-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await expect(page.getByTestId("t1-write-card")).toHaveCount(4);
  await openAllToolCards(page);
  await expect(page.getByText("Source preview shortened; 10 lines omitted")).toBeVisible();
  await expect(page.getByText("Executable", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "assets/mark.svg SVG preview" })).toBeVisible();
  await expect.poll(() => distinctTokenColors(page, "[data-code-view]")).toBeGreaterThan(2);
  await expect(page.getByRole("alert")).toContainText("Write denied by host");
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/t1.4-write-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto("/t1-write-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByTestId("t1-write-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await expect(darkPage.getByTestId("t1-write-card")).toHaveCount(4);
  await openAllToolCards(darkPage);
  await expect.poll(() => distinctTokenColors(darkPage, "[data-code-view]")).toBeGreaterThan(2);
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/t1.4-write-dark.png",
    fullPage: true,
  });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("t1-write-playground")).toBeVisible();
  await expect(page.locator("[data-slot='t1-write-source']").first()).toBeVisible();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/t1.4-write-narrow.png", fullPage: true });
});

/** How many colours the highlighted tokens of a code block take: plain text would take one. */
async function distinctTokenColors(page: Page, scope: string): Promise<number> {
  return page
    .locator(`${scope} [data-code-token]`)
    .evaluateAll(
      (tokens) =>
        new Set(
          tokens
            .filter((token) => (token.textContent ?? "").trim() !== "")
            .map((token) => getComputedStyle(token).color),
        ).size,
    );
}
