/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PLAYGROUND = "/t4-github-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T4/github-playground.tsx",
      "--outdir",
      "dist/t4-github-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for T4 GitHub.");
  writeFileSync(
    join(DIST_ROOT, "t4-github-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div id="t4-github-playground-root"></div>
    <script type="module" src="/t4-github-playground/github-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("renders source-shaped GitHub operations and captures light dark narrow screenshots", async ({
  page,
}) => {
  await page.goto(PLAYGROUND);
  await expect(page.getByTestId("t4-github-playground")).toBeVisible();
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await openAllToolCards(page);
  await expect(page.getByTestId("t4-github-header").first()).toContainText("example/repository");
  await expect(
    page.getByTestId("t4-github-card-github-push").getByTestId("t4-github-result"),
  ).toContainText("Pushed feature/t4-results to origin:feature/t4-results.");
  await expect(
    page.getByTestId("t4-github-card-github-watch").getByTestId("t4-github-actions"),
  ).toContainText("CI");
  const chipWidths = () =>
    page
      .getByTestId("t4-github-card-github-watch")
      .getByTestId("t4-github-status-chip")
      .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
  // A status chip is as wide as its words, never a bar across the card.
  expect(Math.max(...(await chipWidths()))).toBeLessThan(160);
  const style = await page
    .getByTestId("t4-github-header")
    .first()
    .evaluate((node) => {
      const card = node.closest("[data-slot='t4-github-details']");
      if (!card) throw new Error("GitHub style landmark is missing");
      const computed = getComputedStyle(card);
      return { background: computed.backgroundColor, font: computed.fontFamily };
    });
  await expect(page.getByTestId("t4-github-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  expect(style.font).toMatch(/ui|sans/i);
  await page.screenshot({ path: "../../.data/screenshots/t4.4-github-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto(PLAYGROUND);
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByTestId("t4-github-playground")).toBeVisible();
  await openAllToolCards(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/t4.4-github-dark.png",
    fullPage: true,
  });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(Math.max(...(await chipWidths()))).toBeLessThan(160);
  await page.screenshot({ path: "../../.data/screenshots/t4.4-github-narrow.png", fullPage: true });
});
