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
      "src/shortcuts/shortcuts-playground.tsx",
      "--outdir",
      "dist/shortcuts-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for shortcuts.");
  writeFileSync(
    join(DIST_ROOT, "shortcuts-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>omp shortcut playground</title>
  </head>
  <body>
    <div id="shortcuts-playground-root"></div>
    <script type="module" src="/shortcuts-playground/shortcuts-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => buildPlaygroundPage());

test("opens the searchable shortcut sheet in light, dark and narrow modes", async ({ page }) => {
  await page.goto("/shortcuts-playground.html");
  await expect(page.getByText("Shortcut sheet playground")).toBeVisible();
  await page.keyboard.press("Control+/");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Shortcut sheet")).toBeVisible();
  expect(
    await sheet.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--popover").trim(),
    ),
  ).not.toBe("");
  await page.getByRole("textbox", { name: "Search shortcuts" }).fill("todo");
  await expect(sheet.getByText("Toggle todo panel")).toBeVisible();
  await page.screenshot({ path: "../../.data/screenshots/u0-6-sheet-light.png", fullPage: false });
  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => {
    const applyDarkTheme = () => document.documentElement?.classList.add("dark");
    applyDarkTheme();
    new MutationObserver(applyDarkTheme).observe(document, { childList: true });
  });
  await darkPage.goto("/shortcuts-playground.html");
  await darkPage.locator("html").evaluate((element) => element.classList.add("dark"));
  await expect(darkPage.getByText("Shortcut sheet playground")).toBeVisible();
  await darkPage.keyboard.press("Control+/");
  const darkSheet = darkPage.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkSheet).toBeVisible();
  await expect(darkSheet.getByText("Browser reserved")).toBeVisible();
  expect(
    await darkSheet.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--popover").trim(),
    ),
  ).not.toBe("");
  await darkPage.screenshot({
    path: "../../.data/screenshots/u0-6-sheet-dark.png",
    fullPage: false,
  });
  await darkPage.setViewportSize({ width: 390, height: 844 });
  expect(
    await darkSheet.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--popover").trim(),
    ),
  ).not.toBe("");
  await darkPage.screenshot({
    path: "../../.data/screenshots/u0-6-sheet-narrow.png",
    fullPage: false,
  });
  await darkPage.close();
});
