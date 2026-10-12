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
      "src/modules/T7/resolve-playground.tsx",
      "--outdir",
      "dist/t7-resolve-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for resolve cards.");
  writeFileSync(
    join(DIST_ROOT, "t7-resolve-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t7-resolve-playground/resolve-playground.js"></script>
  </head>
  <body>
    <div id="t7-resolve-playground-root"></div>
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
  await expect(page.getByTestId("t7-resolve-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
}

test.beforeAll(buildPlaygroundPage);

test("renders pending/approved/rejected resolve cards in light, dark and narrow layouts", async ({
  page,
}) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/t7-resolve-playground.html");
  await expectStyles(page);
  await openAllToolCards(page);
  await expect(page.getByTestId("t7-resolve-status-resolve-pending")).toHaveAttribute(
    "data-status",
    "pending",
  );
  await expect(page.getByTestId("t7-resolve-status-resolve-approved")).toHaveAttribute(
    "data-status",
    "approved",
  );
  await expect(page.getByTestId("t7-resolve-status-reject-rejected")).toHaveAttribute(
    "data-status",
    "rejected",
  );
  await expect(
    page
      .getByTestId("t7-resolve-status-resolve-pending")
      .getByText("Waiting for the operator to approve device access"),
  ).toBeVisible();
  await page.screenshot({ path: "../../.data/screenshots/t7.3-resolve-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/t7-resolve-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expectStyles(darkPage);
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await darkPage.screenshot({
    path: "../../.data/screenshots/t7.3-resolve-dark.png",
    fullPage: true,
  });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectStyles(page);
  await page.screenshot({
    path: "../../.data/screenshots/t7.3-resolve-narrow.png",
    fullPage: true,
  });
  assertNoConsoleErrors();
});
