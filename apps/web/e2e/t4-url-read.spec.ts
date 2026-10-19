/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T4/url-read-playground.tsx",
      "--outdir",
      "dist/t4-url-read-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the T4 URL playground.");
  writeFileSync(
    join(DIST_ROOT, "t4-url-read-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t4-url-read-playground/url-read-playground.js"></script>
  </head>
  <body><div id="t4-url-read-playground-root"></div></body>
</html>
`,
  );
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

test("renders URL metadata, untrusted Markdown, sources and truncation in light Chrome", async ({
  page,
}) => {
  await page.goto("/t4-url-read-playground.html");
  const playground = page.getByTestId("t4-url-playground");
  await expect(playground).toBeVisible();
  await expect(playground).toHaveCSS("background-color", /^(rgb|oklch)/);
  await openAllToolCards(page);
  await expect(page.getByRole("heading", { name: "Retrieved documentation" })).toBeVisible();
  await expect(page.getByText("example.test/docs → example.test/docs/final")).toBeVisible();
  await expect(page.getByText("Notes:")).toBeVisible();
  const links = page.getByRole("link");
  await expect(links).toHaveCount(3);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("target", "_blank");
  }
  await page.screenshot({
    path: "../../.data/screenshots/t4.2-url-read-light.png",
    fullPage: true,
  });
});

test("starts dark before navigation and keeps the URL card styled", async ({ page }) => {
  await page.addInitScript(() => document.documentElement.classList.add("dark"));
  await page.goto("/t4-url-read-playground.html");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(page.getByTestId("t4-url-playground")).toHaveCSS("background-color", /^(rgb|oklch)/);
  await expect(page.getByTestId("t4-url-read")).toBeVisible();
  await page.screenshot({ path: "../../.data/screenshots/t4.2-url-read-dark.png", fullPage: true });
});

test("reflows the URL card in a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/t4-url-read-playground.html");
  await expect(page.getByTestId("t4-url-playground")).toBeVisible();
  await openAllToolCards(page);
  await expect(page.locator("[data-url-sources]")).toBeVisible();
  await page.screenshot({
    path: "../../.data/screenshots/t4.2-url-read-narrow.png",
    fullPage: true,
  });
});
