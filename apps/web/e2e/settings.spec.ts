/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

type Pixel = readonly [number, number, number];
type StyleEvidence = {
  readonly button: {
    readonly computedBackground: string;
    readonly computedColor: string;
    readonly backgroundPixel: Pixel;
    readonly textContrast: number;
    readonly radius: string;
    readonly font: string;
    readonly height: string;
    readonly borderStyle: string;
  };
  readonly cardPixel: Pixel;
  readonly input: {
    readonly color: string | undefined;
    readonly textFillColor: string | undefined;
    readonly textContrast: number;
  };
  readonly select: {
    readonly color: string | undefined;
    readonly textFillColor: string | undefined;
    readonly textContrast: number;
  };
};

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/S1/settings-kit/playground-entry.tsx",
      "--outfile",
      "dist/s1-settings-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css)
    throw new Error("The production build did not emit an index stylesheet for S1 settings.");
  writeFileSync(
    join(DIST_ROOT, "s1-settings-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <link rel="stylesheet" href="/assets/${css}" />
  </head>
  <body>
    <div id="settings-kit-playground-root"></div>
    <script type="module" src="/s1-settings-playground.js"></script>
  </body>
</html>
`,
  );
}

function luminance([red, green, blue]: Pixel): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

async function collectStyleEvidence(page: Page): Promise<StyleEvidence> {
  return page.getByRole("button", { name: "Replace…" }).evaluate((button: HTMLButtonElement) => {
    const card = button.closest("section");
    const cardStyle = card ? getComputedStyle(card) : null;
    const buttonStyle = getComputedStyle(button);
    const input = document.querySelector("input[type=number]");
    const select = document.querySelector("select");
    const inputStyle = input ? getComputedStyle(input) : null;
    const selectStyle = select ? getComputedStyle(select) : null;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context || !cardStyle) throw new Error("Unable to sample settings colors");
    const pageLuminance = ([red, green, blue]: Pixel): number => {
      const linear = (channel: number) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };
    const composite = (background: string): Pixel => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = cardStyle.backgroundColor;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = background;
      context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
    };
    const paint = (background: string, foreground: string): Pixel => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = cardStyle.backgroundColor;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = background;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = foreground;
      context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
    };
    const contrast = (background: Pixel, text: Pixel) =>
      (Math.max(pageLuminance(background), pageLuminance(text)) + 0.05) /
      (Math.min(pageLuminance(background), pageLuminance(text)) + 0.05);
    const buttonPixel = composite(buttonStyle.backgroundColor);
    const buttonTextPixel = paint(buttonStyle.backgroundColor, buttonStyle.color);
    const inputPixel = inputStyle ? composite(inputStyle.backgroundColor) : buttonPixel;
    const inputTextPixel = inputStyle
      ? paint(inputStyle.backgroundColor, inputStyle.color)
      : buttonTextPixel;
    const selectPixel = selectStyle ? composite(selectStyle.backgroundColor) : buttonPixel;
    const selectTextPixel = selectStyle
      ? paint(selectStyle.backgroundColor, selectStyle.color)
      : buttonTextPixel;
    return {
      button: {
        computedBackground: buttonStyle.backgroundColor,
        computedColor: buttonStyle.color,
        backgroundPixel: buttonPixel,
        textContrast: contrast(buttonPixel, buttonTextPixel),
        radius: buttonStyle.borderRadius,
        font: buttonStyle.fontSize,
        height: buttonStyle.height,
        borderStyle: buttonStyle.borderStyle,
      },
      cardPixel: composite(cardStyle.backgroundColor),
      input: {
        color: inputStyle?.color,
        textFillColor: inputStyle?.webkitTextFillColor,
        textContrast: contrast(inputPixel, inputTextPixel),
      },
      select: {
        color: selectStyle?.color,
        textFillColor: selectStyle?.webkitTextFillColor,
        textContrast: contrast(selectPixel, selectTextPixel),
      },
    };
  });
}

function assertControlEvidence(evidence: StyleEvidence, dark: boolean): void {
  expect(evidence.button.computedBackground).toMatch(/^ok/);
  expect(evidence.button.computedColor).toMatch(/^ok/);
  expect(evidence.input.color).toMatch(/^ok/);
  expect(evidence.select.color).toMatch(/^ok/);
  expect(evidence.button.radius).not.toBe("0px");
  expect(evidence.button.borderStyle).not.toBe("none");
  expect(evidence.button.height).toBe("28px");
  expect(evidence.button.font).toBe("12.8px");
  expect(evidence.input.textContrast).toBeGreaterThanOrEqual(4.5);
  expect(evidence.select.textContrast).toBeGreaterThanOrEqual(4.5);
  if (dark) {
    const cardLum = luminance(evidence.cardPixel);
    const buttonLum = luminance(evidence.button.backgroundPixel);
    expect(buttonLum).toBeLessThan(cardLum + 0.15);
    expect(evidence.button.textContrast).toBeGreaterThanOrEqual(4.5);
    expect(evidence.input.textFillColor ?? evidence.input.color).toContain("0.985");
    expect(evidence.select.textFillColor ?? evidence.select.color).toContain("0.985");
  }
}

test("settings section renders provenance and secret-safe controls", async ({ page }) => {
  await page.goto("/s1-settings-playground.html");
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(page.getByTestId("provider.apiKey-secret-status")).toHaveText("Set");
  await expect(page.getByRole("button", { name: "Replace…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unset" })).toBeVisible();
  await expect(page.locator('input[type="number"]')).toHaveValue("5000");
  await expect(page.locator("body")).not.toContainText("value:");
  assertControlEvidence(await collectStyleEvidence(page), false);
  await page.screenshot({
    path: "../../.data/screenshots/s1-1-settings-light.png",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  await dark.emulateMedia({ colorScheme: "dark" });
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto("/s1-settings-playground.html?theme=dark");
  await expect(dark.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(dark.locator('input[type="number"]')).toHaveValue("5000");
  await expect(dark.locator("html")).toHaveClass("dark");
  const darkEvidence = await collectStyleEvidence(dark);
  assertControlEvidence(darkEvidence, true);
  await dark.screenshot({ path: "../../.data/screenshots/s1-1-settings-dark.png", fullPage: true });
  await dark.setViewportSize({ width: 390, height: 844 });
  await dark.screenshot({
    path: "../../.data/screenshots/s1-1-settings-narrow.png",
    fullPage: true,
  });
  await dark.close();
});
