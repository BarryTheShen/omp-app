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
      "src/modules/T4/browser-playground.tsx",
      "--outdir",
      "dist/t4-browser-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error(
      "The production build did not emit a stylesheet for the T4 browser playground.",
    );
  writeFileSync(
    join(DIST_ROOT, "t4-browser-playground.html"),
    `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/assets/${css}" /><link rel="icon" href="data:," /><script type="module" src="/t4-browser-playground/browser-playground.js"></script></head><body><div id="t4-browser-playground-root"></div></body></html>`,
  );
}

test.beforeAll(() => buildPlaygroundPage());

test("renders browser action, returned value, screenshot metadata and raw toggle in light Chrome", async ({
  page,
}) => {
  await page.goto("/t4-browser-playground.html");
  const playground = page.getByTestId("t4-browser-playground");
  await expect(playground).toBeVisible();
  await expect(playground).toHaveCSS("background-color", /^(rgb|oklch)/);
  await expect(page.getByText("Run · docs · https://bun.sh/docs")).toBeVisible();
  await openAllToolCards(page);
  await expect(page.getByTestId("t4-browser-value")).toContainText("Returned value");
  await expect(page.getByTestId("t4-browser-screenshots")).toContainText(
    "image/png, 1280 × 800, 2048 bytes",
  );
  await page.getByText("Raw details").click();
  await expect(page.getByText("Result")).toBeVisible();
  await page.screenshot({ path: "../../.data/screenshots/t4.3-browser-light.png", fullPage: true });
});

test("starts dark before navigation and stays styled", async ({ page }) => {
  await page.addInitScript(() => document.documentElement.classList.add("dark"));
  await page.goto("/t4-browser-playground.html");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByTestId("t4-browser-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await openAllToolCards(page);
  await page.screenshot({ path: "../../.data/screenshots/t4.3-browser-dark.png", fullPage: true });
});

test("reflows browser action card narrowly", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/t4-browser-playground.html");
  await expect(page.getByTestId("t4-browser-playground")).toBeVisible();
  await expect(page.getByTestId("t4-browser-card")).toBeVisible();
  await openAllToolCards(page);
  await page.screenshot({
    path: "../../.data/screenshots/t4.3-browser-narrow.png",
    fullPage: true,
  });
});
