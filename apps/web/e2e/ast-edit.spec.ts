/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { openAllToolCards, waitForFiniteAnimations } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T1/ast-edit-playground.tsx",
      "--outdir",
      "dist/t1-ast-edit-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the AST edit playground.");
  writeFileSync(
    join(DIST_ROOT, "t1-ast-edit-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t1-ast-edit-playground/ast-edit-playground.js"></script>
  </head>
  <body>
    <div id="t1-ast-edit-playground-root"></div>
  </body>
</html>
`,
  );
}

function failOnConsoleErrors(page: import("@playwright/test").Page): () => void {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

async function expectStyles(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(page.getByTestId("t1-ast-edit-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

test("renders AST edit structural diffs, parse errors and safety limits in light/dark/narrow Chrome", async ({
  page,
}) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/t1-ast-edit-playground.html");
  await expectStyles(page);
  await expect(page.getByTestId("t1-ast-edit-card-ast-edit-success")).toBeVisible();
  await openAllToolCards(page);
  await expect(page.getByText("console.log(value)").first()).toBeVisible();
  await expect(page.getByText("logger.info(value)").first()).toBeVisible();
  await expect(page.getByTestId("t1-ast-edit-preview")).toContainText(
    "## logger.ts (2 replacements)",
  );
  await expect(page.getByTestId("t1-ast-edit-replacements")).toContainText("src/logger.ts");
  await expect(page.getByTestId("t1-ast-edit-replacements")).toContainText("2 replacements");
  await expect(page.getByTestId("t1-ast-edit-preview")).toContainText("-10│console.log(value)");
  await expect(page.getByTestId("t1-ast-edit-preview")).toContainText(
    "## logger.test.ts (1 replacement)",
  );
  await waitForFiniteAnimations(page);
  await expect(page.getByRole("alert")).toContainText("Parse errors");
  await page.screenshot({
    path: "../../.data/screenshots/t1.5-ast-edit-light.png",
    fullPage: true,
  });

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/t1-ast-edit-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expectStyles(darkPage);
  await openAllToolCards(darkPage);
  await expect(darkPage.getByTestId("t1-ast-edit-preview")).toContainText("-10│console.log(value)");
  await waitForFiniteAnimations(darkPage);
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await darkPage.screenshot({
    path: "../../.data/screenshots/t1.5-ast-edit-dark.png",
    fullPage: true,
  });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await expect(page.getByTestId("t1-ast-edit-preview")).toContainText("-10│console.log(value)");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: "../../.data/screenshots/t1.5-ast-edit-narrow.png",
    fullPage: true,
  });
  assertNoConsoleErrors();
});
