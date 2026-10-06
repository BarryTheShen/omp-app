/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");
const PAGE_NAME = "s1-3-appearance";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/S1/settings/playground.tsx",
      "--outfile",
      `dist/${PAGE_NAME}.js`,
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The web build did not emit a stylesheet for the appearance playground.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, `${PAGE_NAME}.html`),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Appearance settings playground</title>
  </head>
  <body>
    <div id="appearance-settings-playground-root"></div>
    <script type="module" src="/${PAGE_NAME}.js"></script>
  </body>
</html>
`,
  );
}

async function expectBackgroundToken(page: Page, background: string, token: string): Promise<void> {
  const root = page.locator("[data-s1-appearance-settings]");
  await expect(root).toBeVisible();
  await expect(root.locator("[data-appearance-preview]")).toBeVisible();
  await expect
    .poll(() => root.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe(background);
  await expect
    .poll(() =>
      root.evaluate((element) => getComputedStyle(element).getPropertyValue("--background").trim()),
    )
    .toBe(token);
}
async function expectSampleImage(page: Page): Promise<void> {
  const sampleImage = page.getByRole("img", { name: "Inline image preview" });
  await expect(sampleImage).toBeVisible();
  await expect(sampleImage).toHaveCSS("max-height", "160px");
  await expect(page.getByText("Sample image")).toBeVisible();
}

async function waitForAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.playState === "running")
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("appearance settings previews, commits, and fits narrow screens in both palettes", async ({
  browser,
}) => {
  const lightPage = await browser.newPage({
    colorScheme: "light",
    viewport: { width: 1280, height: 960 },
  });
  await lightPage.goto(`/${PAGE_NAME}.html`);
  await expect(lightPage.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(lightPage.locator("[data-appearance-preview]")).toHaveAttribute(
    "data-palette",
    "light",
  );
  await expectBackgroundToken(lightPage, "oklch(0.9791 0 0)", "oklch(97.91% 0 0)");
  await expectSampleImage(lightPage);
  await waitForAnimations(lightPage);
  await lightPage.screenshot({
    path: join(SCREENSHOT_ROOT, "s1-3-appearance-light.png"),
    fullPage: true,
  });

  const darkPage = await browser.newPage({
    colorScheme: "dark",
    viewport: { width: 1280, height: 960 },
  });
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto(`/${PAGE_NAME}.html`);
  await expect(darkPage.locator("[data-appearance-preview]")).toHaveAttribute(
    "data-palette",
    "dark",
  );
  await expectBackgroundToken(
    darkPage,
    "oklch(0.2096 0.0166 268.85)",
    "oklch(20.96% .0166 268.85)",
  );
  await expectSampleImage(darkPage);
  await waitForAnimations(darkPage);
  await darkPage.screenshot({
    path: join(SCREENSHOT_ROOT, "s1-3-appearance-dark.png"),
    fullPage: true,
  });

  await lightPage.getByRole("button", { name: "Choose dark theme…" }).click();
  await lightPage.getByLabel("OMP theme name").fill("custom-dark");
  await expect(
    lightPage.getByText(
      "The app uses omp's default titanium and light colors; other omp themes apply in the terminal.",
    ),
  ).toBeVisible();
  await lightPage.getByRole("button", { name: "Use this theme name" }).click();
  await lightPage.getByRole("button", { name: "Save changes" }).click();
  await expect(lightPage.getByText("Applied")).toBeVisible();

  await lightPage.getByRole("tab", { name: "Images" }).click();
  await lightPage.getByRole("button", { name: "Show images selector…" }).click();
  await lightPage.getByRole("button", { name: "No" }).focus();
  await expect(lightPage.getByText("Image placeholder")).toBeVisible();
  await lightPage.getByRole("button", { name: "Yes" }).focus();
  await expectSampleImage(lightPage);
  await lightPage.setViewportSize({ width: 390, height: 844 });
  await expectBackgroundToken(lightPage, "oklch(0.9791 0 0)", "oklch(97.91% 0 0)");
  const dimensions = await lightPage.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await waitForAnimations(lightPage);
  await lightPage.screenshot({
    path: join(SCREENSHOT_ROOT, "s1-3-appearance-narrow.png"),
    fullPage: true,
  });

  await lightPage.getByRole("button", { name: "Cancel" }).click();
  await expect(lightPage.getByRole("img", { name: "Inline image preview" })).toBeVisible();
  await lightPage.close();
  await darkPage.close();
});
