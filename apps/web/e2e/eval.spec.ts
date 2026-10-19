/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PLAYGROUND = "/t3-eval-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T3/eval-playground.tsx",
      "--outdir",
      "dist/t3-eval-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for T3 eval.");
  writeFileSync(
    join(DIST_ROOT, "t3-eval-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div id="t3-eval-playground-root"></div>
    <script type="module" src="/t3-eval-playground/eval-playground.js"></script>
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

test("renders eval cells streamed output async jobs and images with light dark evidence", async ({
  page,
}) => {
  await page.goto(PLAYGROUND);
  await expect(page.getByTestId("t3-eval-playground")).toBeVisible();
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  // A finished eval card starts as one line: open the cards so their cells and output are on the page.
  await openAllToolCards(page);
  await expect(page.getByTestId("t3-eval-cell-0").first()).toBeVisible();
  await expect(page.getByTestId("t3-eval-async-job").first()).toContainText("job-running");
  const image = page.getByRole("img", { name: "Evaluation result" });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/);
  const style = await page
    .getByTestId("t3-eval-header")
    .first()
    .evaluate((node) => {
      const language = node.querySelector<HTMLElement>("[data-eval-language]");
      const card = node.closest("[data-slot='u3-tool-card']");
      if (!language || !card) throw new Error("Eval style landmarks are missing");
      const languageStyle = getComputedStyle(language);
      const cardStyle = getComputedStyle(card);
      return { font: languageStyle.fontFamily, background: cardStyle.backgroundColor };
    });
  expect(style.font).toMatch(/mono/i);
  await expect(page.getByTestId("t3-eval-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await page.screenshot({ path: "../../.data/screenshots/t3.2-eval-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto(PLAYGROUND);
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByTestId("t3-eval-playground")).toBeVisible();
  await openAllToolCards(darkPage);
  await expect(darkPage.getByTestId("t3-eval-async-job").first()).toContainText("job-running");
  await expect(darkPage.getByRole("img", { name: "Evaluation result" })).toBeVisible();
  const darkBackground = await darkPage
    .getByTestId("t3-eval-playground")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(darkBackground).toMatch(/^(rgb|oklch)/);
  await darkPage.screenshot({ path: "../../.data/screenshots/t3.2-eval-dark.png", fullPage: true });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("t3-eval-playground")).toBeVisible();
  await expect(page.getByRole("img", { name: "Evaluation result" })).toBeVisible();
  const narrowBackground = await page
    .getByTestId("t3-eval-playground")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(narrowBackground).toMatch(/^(rgb|oklch)/);
  await page.screenshot({ path: "../../.data/screenshots/t3.2-eval-narrow.png", fullPage: true });
});
