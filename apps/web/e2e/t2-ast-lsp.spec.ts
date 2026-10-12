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
      "src/modules/T2/ast-lsp-playground.tsx",
      "--outdir",
      "dist/t2-ast-lsp-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error(
      "The production build did not emit a stylesheet for the AST grep and language server playground.",
    );
  writeFileSync(
    join(DIST_ROOT, "t2-ast-lsp-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t2-ast-lsp-playground/ast-lsp-playground.js"></script>
  </head>
  <body>
    <div id="t2-ast-lsp-playground-root"></div>
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
  await expect(page.getByTestId("t2-ast-lsp-playground")).toHaveCSS(
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
  await expect(page.getByText("console.log($$$ARGS) in src · 3 matches")).toBeVisible();
  await expect(page.getByText("line 31")).toBeVisible();
  await expect(page.getByText("No matches.")).toBeVisible();
  await expect(page.getByText("Hover · src/app.ts:12")).toBeVisible();
  await expect(
    page.getByText("Returns how many retries are left for this request.").first(),
  ).toBeVisible();
  await expect(page.getByText("Cannot find name 'retry'. (2304)").first()).toBeVisible();
  await expect(page.getByText("References to retryBudget").first()).toBeVisible();
  await expect(page.getByText("Showing 20 of 27").first()).toBeVisible();
  await expect(page.getByTestId("tool-card-lsp-running")).toHaveAttribute("data-phase", "running");
  // Raw details keeps its JSON in a closed <details>; it may exist in the DOM but must stay hidden.
  const details = await page.getByText(/"details"/).all();
  await Promise.all(details.map((raw) => expect(raw).toBeHidden()));
}

test.beforeAll(buildPlaygroundPage);

test("renders ast_grep matches and lsp hover, diagnostics, references and running in light/dark/narrow layouts", async ({
  page,
}) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/t2-ast-lsp-playground.html");
  await expectStyles(page);
  await expectCards(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/t2.5-ast-lsp-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/t2-ast-lsp-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expectStyles(darkPage);
  await expectCards(darkPage);
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/t2.5-ast-lsp-dark.png",
    fullPage: true,
  });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: "../../.data/screenshots/t2.5-ast-lsp-narrow.png",
    fullPage: true,
  });
  assertNoConsoleErrors();
});
