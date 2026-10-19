/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const playground = "/u5-panel-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U5/panel/playground.tsx",
      "--outfile",
      "dist/u5-panel-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the U5.2 playground.");
  writeFileSync(
    join(DIST_ROOT, "u5-panel-playground.html"),
    `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp U5.2 PanelShell playground</title>
  </head>
  <body>
    <div id="u5-panel-playground-root"></div>
    <script type="module" src="/u5-panel-playground.js"></script>
  </body>
</html>
`,
  );
}

function contrastRatio(foreground: string, background: string): number {
  const parse = (value: string): [number, number, number] => {
    const channels = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (value.startsWith("oklch") && channels.length >= 3) {
      const lightness = channels[0] ?? 0;
      const chroma = channels[1] ?? 0;
      const hue = channels[2] ?? 0;
      const angle = (hue * Math.PI) / 180;
      const a = chroma * Math.cos(angle);
      const b = chroma * Math.sin(angle);
      const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
      return [
        255 * Math.min(1, Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
        255 * Math.min(1, Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
        255 * Math.min(1, Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
      ];
    }
    return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0];
  };
  const luminance = ([red, green, blue]: [number, number, number]) => {
    const weights: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];
    return [red, green, blue]
      .map((channel) => channel / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * (weights[index] ?? 0), 0);
  };
  const lighter = Math.max(luminance(parse(foreground)), luminance(parse(background)));
  const darker = Math.min(luminance(parse(foreground)), luminance(parse(background)));
  return (lighter + 0.05) / (darker + 0.05);
}

async function expectPanelContrast(page: Page) {
  const ratio = await page
    .getByRole("region", { name: "Todo panel" })
    .evaluate((node: HTMLElement) => {
      const style = getComputedStyle(node);
      const heading = node.querySelector("h2");
      const headingStyle = heading ? getComputedStyle(heading) : style;
      return { foreground: headingStyle.color, background: style.backgroundColor };
    });
  expect(contrastRatio(ratio.foreground, ratio.background)).toBeGreaterThanOrEqual(4.5);
}

test.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    buildPlaygroundPage();
  }),
);

test.describe("U5.2 PanelShell playground", () => {
  test("captures ready/loading/error states and checks light/dark contrast", async ({ page }) => {
    await page.addInitScript(() => document.documentElement.classList.add("dark"));
    await page.goto(playground);
    const panel = page.getByRole("region", { name: "Todo panel" });
    await expect(panel).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectPanelContrast(page);
    await page.screenshot({ path: "../../.data/screenshots/u5.2-ready-dark.png", fullPage: true });

    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expectPanelContrast(page);
    await page.screenshot({ path: "../../.data/screenshots/u5.2-ready-light.png", fullPage: true });

    await page.getByTestId("theme-dark").click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByTestId("state-loading").click();
    await expect(panel.locator('[role="status"]')).toHaveText("Loading");
    await page.screenshot({
      path: "../../.data/screenshots/u5.2-loading-dark.png",
      fullPage: true,
    });

    await page.getByTestId("state-error").click();
    await expect(panel.getByRole("alert")).toHaveText(/Panel data failed/);
    await expectPanelContrast(page);
    await page.screenshot({ path: "../../.data/screenshots/u5.2-error-dark.png", fullPage: true });
  });

  test("becomes the U0 drawer on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(playground);
    const panel = page.getByRole("region", { name: "Todo panel" });
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-panel-layout", "drawer");
    await page.screenshot({
      path: "../../.data/screenshots/u5.2-narrow-drawer.png",
      fullPage: true,
    });
  });
});
