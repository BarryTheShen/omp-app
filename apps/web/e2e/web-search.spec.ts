/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T4/web-search-playground.tsx",
      "--outdir",
      "dist/t4-web-search-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error(
      "The production build did not emit a stylesheet for the web-search playground.",
    );
  writeFileSync(
    join(DIST_ROOT, "t4-web-search-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t4-web-search-playground/web-search-playground.js"></script>
  </head>
  <body>
    <div id="t4-web-search-playground-root"></div>
  </body>
</html>
`,
  );
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("renders search answers, sources and provider errors in light/dark/narrow layouts", async ({
  page,
}) => {
  await page.goto("/t4-web-search-playground.html");
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(page.getByTestId("t4-web-search-playground")).toBeVisible();
  await expect(page.getByTestId("t4-web-search-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await expect(page.getByTestId("t4-web-search-card")).toHaveCount(3);
  await openAllToolCards(page);
  await expect(page.getByRole("heading", { name: "Omp app" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Omp app documentation" }).first()).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(page.getByText("[1]")).toBeVisible();
  await expect(page.getByText("No sources were returned for this search.").first()).toBeVisible();
  await expect(page.getByText("Provider rejected the request")).toBeVisible();
  await expect(page.getByRole("button", { name: "web_search: Error" })).toBeVisible();
  await page.screenshot({
    path: "../../.data/screenshots/t4.5-web-search-light.png",
    fullPage: true,
  });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto("/t4-web-search-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByTestId("t4-web-search-playground")).toBeVisible();
  await expect(darkPage.getByTestId("t4-web-search-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await darkPage.screenshot({
    path: "../../.data/screenshots/t4.5-web-search-dark.png",
    fullPage: true,
  });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("t4-web-search-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await page.screenshot({
    path: "../../.data/screenshots/t4.5-web-search-narrow.png",
    fullPage: true,
  });
});
