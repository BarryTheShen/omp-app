/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

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

async function expectBackgroundToken(page: Page): Promise<void> {
  await expect(
    page.getByText("These settings change omp's terminal only. This app does not use them.", {
      exact: true,
    }),
  ).toBeVisible();
  const background = await page.evaluate(() => {
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    const pageBackground = getComputedStyle(document.body).backgroundColor;
    probe.remove();
    return { token, resolved, pageBackground };
  });
  expect(background.token).not.toBe("");
  expect(background.pageBackground).toBe(background.resolved);
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

test.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    buildPlaygroundPage();
  }),
);

test("appearance settings commit terminal values and fit narrow screens in both palettes", async ({
  browser,
}) => {
  const lightPage = await browser.newPage({
    colorScheme: "light",
    viewport: { width: 1280, height: 960 },
  });
  await lightPage.goto(`/${PAGE_NAME}.html`);
  await expectBackgroundToken(lightPage);
  await waitForAnimations(lightPage);
  await lightPage.screenshot({
    path: join(SCREENSHOT_ROOT, "s1-3-appearance-light.png"),
    fullPage: true,
  });

  const darkPage = await browser.newPage({
    colorScheme: "dark",
    viewport: { width: 1280, height: 960 },
  });
  await darkPage.addInitScript(() => {
    document.documentElement.classList.add("dark");
    window.localStorage.setItem("omp-app.theme", "dark");
  });
  await darkPage.goto(`/${PAGE_NAME}.html`);
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expectBackgroundToken(darkPage);
  await expect(darkPage.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await waitForAnimations(darkPage);
  await darkPage.screenshot({
    path: join(SCREENSHOT_ROOT, "s1-3-appearance-dark.png"),
    fullPage: true,
  });

  await lightPage.getByRole("button", { name: "Choose dark theme…" }).click();
  await lightPage.getByLabel("OMP theme name").fill("custom-dark");
  await expect(
    lightPage.getByText("These settings change omp's terminal only. This app does not use them.", {
      exact: true,
    }),
  ).toBeVisible();
  await lightPage.getByRole("button", { name: "Use this theme name" }).click();
  await expect
    .poll(() => lightPage.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(false);
  await lightPage.getByRole("button", { name: "Save changes" }).click();
  await expect(lightPage.getByText("Applied")).toBeVisible();

  await lightPage.setViewportSize({ width: 390, height: 844 });
  await expectBackgroundToken(lightPage);
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
  await expect(
    lightPage.getByText("These settings change omp's terminal only. This app does not use them.", {
      exact: true,
    }),
  ).toBeVisible();
  await lightPage.close();
  await darkPage.close();
});
