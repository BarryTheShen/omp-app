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
    ["build", "src/palette/playground.tsx", "--outdir", "dist/u0-7-palette", "--target=browser"],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for the palette.");
  const playgroundHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/u0-7-palette/playground.js"></script>
  </head>
  <body>
    <div id="u0-7-palette-root"></div>
  </body>
</html>
`;
  writeFileSync(join(DIST_ROOT, "u0-7-palette.html"), playgroundHtml);
  writeFileSync(
    join(DIST_ROOT, "u0-7-palette-dark.html"),
    playgroundHtml.replace('<html lang="en">', '<html lang="en" class="dark">'),
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

async function expectPaletteStyles(page: Page): Promise<void> {
  const background = page.getByTestId("u0-7-palette-playground");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(background).toHaveCSS("background-color", /^(rgb|oklch)/);
  const colors = await Promise.all([
    dialog.evaluate((element) => getComputedStyle(element).backgroundColor),
    page
      .getByTestId("popover-token-probe")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(colors[0]).toMatch(/^(rgb|oklch)/);
  expect(colors[0]).toBe(colors[1]);
}

async function openPalette(page: Page): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Composer input" });
  await composer.focus();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await expect(dialog.locator('[role="option"][aria-disabled="true"]').first()).toBeVisible();
  await expect(
    dialog
      .getByText(
        /current session has not confirmed|does not support|does not provide|not available|needs a newer version/,
      )
      .first(),
  ).toBeVisible();
}

async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

test.beforeAll(buildPlaygroundPage);

test("opens real registry commands in light, dark, and narrow layouts", async ({ page }) => {
  const assertNoConsoleErrors = failOnConsoleErrors(page);
  await page.goto("/u0-7-palette.html");
  await openPalette(page);
  await expectPaletteStyles(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/u0-7-palette-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  const assertDarkNoConsoleErrors = failOnConsoleErrors(darkPage);
  await darkPage.addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await darkPage.goto("/u0-7-palette-dark.html");
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await openPalette(darkPage);
  await expectPaletteStyles(darkPage);
  await waitForFiniteAnimations(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/u0-7-palette-dark.png",
    fullPage: true,
  });
  assertDarkNoConsoleErrors();
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectPaletteStyles(page);
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds === null) throw new Error("The command palette has no visible bounds.");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: "../../.data/screenshots/u0-7-palette-narrow.png",
    fullPage: true,
  });
  assertNoConsoleErrors();
});
