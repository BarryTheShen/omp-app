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
      "src/modules/T2/glob-playground.tsx",
      "--outdir",
      "dist/t2-glob-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the glob playground.");
  writeFileSync(
    join(DIST_ROOT, "t2-glob-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t2-glob-playground/glob-playground.js"></script>
  </head>
  <body>
    <div id="t2-glob-playground-root"></div>
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
  await expect(page.getByTestId("t2-glob-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
}

test.beforeAll(buildPlaygroundPage);

test("renders linked glob files, missing paths and truncation in light/dark/narrow layouts", async ({
  page,
}) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/t2-glob-playground.html");
  await expectStyles(page);
  await expect(page.getByRole("link", { name: "src/app.ts" })).toBeVisible();
  await expect(page.getByTestId("t2-glob-limit")).toContainText("57 found");
  await expect(page.getByText("Showing 20 of 57 (+37 more)")).toBeVisible();
  await expect(page.getByText("No matches.")).toBeVisible();
  await expect(page.getByText("Pattern: **/*.ts").first()).toBeVisible();
  await page.screenshot({ path: "../../.data/screenshots/t2.3-glob-light.png", fullPage: true });
  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/t2-glob-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expectStyles(darkPage);
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await darkPage.screenshot({ path: "../../.data/screenshots/t2.3-glob-dark.png", fullPage: true });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await page.screenshot({ path: "../../.data/screenshots/t2.3-glob-narrow.png", fullPage: true });
  assertNoConsoleErrors();
});
