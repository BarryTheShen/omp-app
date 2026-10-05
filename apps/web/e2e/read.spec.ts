/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T1/read-playground.tsx",
      "--outdir",
      "dist/t1-read-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the read playground.");
  writeFileSync(
    join(DIST_ROOT, "t1-read-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t1-read-playground/read-playground.js"></script>
  </head>
  <body>
    <div id="t1-read-playground-root"></div>
  </body>
</html>
`,
  );
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("renders read text, URL fallback and image states in light/dark/narrow layouts", async ({
  page,
}) => {
  await page.goto("/t1-read-playground.html");
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(page.getByTestId("t1-read-playground")).toBeVisible();
  await expect(page.getByTestId("t1-read-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await expect(page.getByTestId("t1-read-card")).toHaveCount(3);
  await expect(page.getByText("export const answer = 42;")).toBeVisible();
  await expect(page.getByText("URL renderer unavailable")).toBeVisible();
  await expect(page.getByRole("img", { name: "assets/logo.png" })).toBeVisible();
  await page.screenshot({ path: "../../.data/screenshots/t1.2-read-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto("/t1-read-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.getByTestId("t1-read-playground")).toBeVisible();
  await expect(darkPage.getByTestId("t1-read-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await darkPage.screenshot({ path: "../../.data/screenshots/t1.2-read-dark.png", fullPage: true });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("t1-read-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await page.screenshot({ path: "../../.data/screenshots/t1.2-read-narrow.png", fullPage: true });
});
