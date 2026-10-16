/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openAllToolCards, waitForFiniteAnimations } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T1/edit-playground.tsx",
      "--outdir",
      "dist/t1-edit-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the edit playground.");
  writeFileSync(
    join(DIST_ROOT, "t1-edit-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t1-edit-playground/edit-playground.js"></script>
  </head>
  <body>
    <div id="t1-edit-playground-root"></div>
  </body>
</html>
`,
  );
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("renders edit and apply_patch diffs in light, dark and narrow layouts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/t1-edit-playground.html");
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(page.getByTestId("t1-edit-playground")).toBeVisible();
  await expect(page.getByTestId("t1-edit-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await expect(page.getByTestId("t1-edit-card")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "edit: Complete" })).toBeVisible();
  await expect(page.getByRole("button", { name: "apply_patch: Complete" })).toBeVisible();
  await openAllToolCards(page);
  await expect(page.getByText("patch: Review generated export")).toBeVisible();
  await expect(page.getByText("Streaming preview")).toBeVisible();
  await expect(page.getByTestId("t1-edit-diff-code")).toHaveCount(3);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/t1.3-edit-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.setViewportSize({ width: 1280, height: 1400 });
  await darkPage.goto("/t1-edit-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByTestId("t1-edit-playground")).toBeVisible();
  await expect(darkPage.getByTestId("t1-edit-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await openAllToolCards(darkPage);
  await expect(darkPage.getByText("patch: Review generated export")).toBeVisible();
  await expect(darkPage.getByTestId("t1-edit-diff-code")).toHaveCount(3);
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({ path: "../../.data/screenshots/t1.3-edit-dark.png", fullPage: true });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("t1-edit-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await expect(page.getByText("patch: Review generated export")).toBeVisible();
  await expect(page.getByTestId("t1-edit-diff-code")).toHaveCount(3);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/t1.3-edit-narrow.png", fullPage: true });
});
