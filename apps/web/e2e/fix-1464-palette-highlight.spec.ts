import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 1464: in the dark theme the command palette's highlighted row (the one Enter runs) has the same background as the
 * panel around it, so a keyboard user cannot see which command is selected. The row is measured against the panel in
 * light, dark and while hovered. Captures: light, dark and 390 px wide.
 */

/** The smallest contrast ratio between the highlighted row and the panel. The light theme's grey row measures about 1.2. */
const MIN_CONTRAST = 1.15;

type Rgb = readonly [number, number, number];

/** Sets the colour scheme the way the browser does (the app follows System by default), then waits for the theme. */
async function setColorScheme(page: Page, dark: boolean): Promise<void> {
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", dark ? "dark" : "light");
  await waitForFiniteAnimations(page);
}

/**
 * Runs in the page: the colour an element paints as sRGB. The background is read back through a canvas, so every colour
 * syntax the theme uses (oklch included) is compared as the pixels it paints.
 */
function paintedRgb(element: Element): [number, number, number] {
  const context = document.createElement("canvas").getContext("2d");
  if (context === null) throw new Error("no canvas");
  context.fillStyle = getComputedStyle(element).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return [red ?? 0, green ?? 0, blue ?? 0];
}

/** The relative luminance of an sRGB colour, as WCAG defines it. */
function luminance([red, green, blue]: Rgb): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** The WCAG contrast ratio of two sRGB colours: 1 when they are the same colour. */
function contrastRatio(first: Rgb, second: Rgb): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/** The highlighted row and the panel around it, as the colours they paint and their contrast. */
async function measure(palette: Locator): Promise<{ row: Rgb; panel: Rgb; contrast: number }> {
  const row = palette.getByRole("option", { selected: true });
  await expect(row, "a row is highlighted").toHaveCount(1);
  const rowRgb = await row.evaluate(paintedRgb);
  const panelRgb = await palette.evaluate(paintedRgb);
  return { row: rowRgb, panel: panelRgb, contrast: contrastRatio(rowRgb, panelRgb) };
}

function describe(measured: { row: Rgb; panel: Rgb; contrast: number }): string {
  return `highlighted row rgb(${measured.row.join(", ")}) against panel rgb(${measured.panel.join(", ")}), contrast ${measured.contrast.toFixed(2)}`;
}

async function capture(palette: Locator, name: string): Promise<void> {
  await palette.screenshot({ path: join(screenshots, "fix-1464", `${name}.png`) });
}

/** Writes one measurement beside the captures, so the colours a run measured can be read after it. */
async function record(
  name: string,
  measured: { row: Rgb; panel: Rgb; contrast: number },
): Promise<void> {
  await mkdir(join(screenshots, "fix-1464"), { recursive: true });
  await writeFile(
    join(screenshots, "fix-1464", `colours-${name}.json`),
    `${JSON.stringify(measured, null, 2)}\n`,
  );
}

realTest(
  "the palette's highlighted row stands out from the panel in the light, dark and hovered states",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1100, height: 900 });
    const composer = await startChat(page);
    await composer.focus();
    await page.keyboard.press("Control+k");

    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette.getByRole("option").first()).toBeVisible({ timeout: 30_000 });
    await setColorScheme(page, false);
    const light = await measure(palette);
    expect(light.contrast, `light theme: ${describe(light)}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    await record("light", light);
    await capture(palette, "light");

    await setColorScheme(page, true);
    const dark = await measure(palette);
    expect(dark.contrast, `dark theme: ${describe(dark)}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    await record("dark", dark);
    await capture(palette, "dark");

    await palette.getByRole("option", { selected: true }).hover();
    const hovered = await measure(palette);
    expect(hovered.contrast, `dark theme, hovered: ${describe(hovered)}`).toBeGreaterThanOrEqual(
      MIN_CONTRAST,
    );
    await record("hovered", hovered);

    // The narrow capture waits for both drawers to report closed, so neither covers the palette.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "false");
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await expect(palette.getByRole("option").first()).toBeVisible();
    await waitForFiniteAnimations(page);
    await capture(palette, "390");
    expect(realApp.problems).toEqual([]);
  },
);
