/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");
const PAGE_NAME = "s1-5-settings-gate";

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
  if (!css) throw new Error("The web build did not emit a stylesheet for the S1 settings gate.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, `${PAGE_NAME}.html`),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>S1 settings accessibility gate</title>
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
  const root = page.locator("[data-s1-appearance-settings]");
  await expect(root).toBeVisible();
  await expect(root.locator("[data-s1-appearance-section]")).toBeVisible();
  const background = await root.evaluate((element) => {
    const token = getComputedStyle(element).getPropertyValue("--background").trim();
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    const actual = getComputedStyle(element).backgroundColor;
    probe.remove();
    return { token, resolved, actual };
  });
  expect(background.token).not.toBe("");
  expect(background.actual).toBe(background.resolved);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
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

test("S1 settings retain keyboard, focus, reduced motion and 200% zoom behavior", async ({
  browser,
}) => {
  const lightPage = await browser.newPage({
    colorScheme: "light",
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 960 },
  });
  await lightPage.goto(`/${PAGE_NAME}.html`);
  await expect(lightPage.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(
    lightPage.getByText("These settings change omp's terminal only. This app does not use them.", {
      exact: true,
    }),
  ).toBeVisible();
  await expectBackgroundToken(lightPage);
  const reducedMotionDuration = await lightPage.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--duration-base").trim(),
  );
  expect(reducedMotionDuration).toBe(".01ms");
  await waitForAnimations(lightPage);
  await lightPage.screenshot({
    path: join(SCREENSHOT_ROOT, "s1-5-settings-gate-light.png"),
    fullPage: true,
  });

  const closeButton = lightPage.getByRole("button", { name: "Close settings" });
  await lightPage.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  const focusRing = await closeButton.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(focusRing).not.toBe("none");

  const darkPage = await browser.newPage({
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 960 },
  });
  await darkPage.addInitScript(() => {
    document.documentElement.classList.add("dark");
    window.localStorage.setItem("omp-app.theme", "dark");
  });
  await darkPage.goto(`/${PAGE_NAME}.html`);
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(
    darkPage.getByText("These settings change omp's terminal only. This app does not use them.", {
      exact: true,
    }),
  ).toBeVisible();
  await expectBackgroundToken(darkPage);
  await waitForAnimations(darkPage);
  await darkPage.screenshot({
    path: join(SCREENSHOT_ROOT, "s1-5-settings-gate-dark.png"),
    fullPage: true,
  });

  const themeButton = lightPage.getByRole("button", { name: "Choose dark theme…" });
  await themeButton.focus();
  await expect(themeButton).toBeFocused();
  await lightPage.keyboard.press("Enter");
  await expect(lightPage.getByRole("heading", { name: "Choose dark theme" })).toBeVisible();
  const bundledLight = lightPage.getByRole("button", { name: "Light" });
  await bundledLight.focus();
  await expect(bundledLight).toBeFocused();
  await lightPage.keyboard.press("Enter");
  await expect(lightPage.locator("[data-s1-appearance-section]")).toBeVisible();

  await lightPage.locator("html").evaluate((element) => {
    (element as HTMLElement).style.zoom = "200%";
  });
  await expectBackgroundToken(lightPage);
  await expectNoHorizontalOverflow(lightPage);
  await waitForAnimations(lightPage);
  await lightPage.screenshot({
    path: join(SCREENSHOT_ROOT, "s1-5-settings-gate-zoom.png"),
    fullPage: true,
  });

  const narrowPage = await browser.newPage({
    colorScheme: "light",
    reducedMotion: "reduce",
    viewport: { width: 390, height: 844 },
  });
  await narrowPage.goto(`/${PAGE_NAME}.html`);
  await expect(narrowPage.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expectBackgroundToken(narrowPage);
  await expectNoHorizontalOverflow(narrowPage);
  await waitForAnimations(narrowPage);
  await narrowPage.screenshot({
    path: join(SCREENSHOT_ROOT, "s1-5-settings-gate-narrow.png"),
    fullPage: true,
  });

  await lightPage.close();
  await darkPage.close();
  await narrowPage.close();
});
