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
      "src/modules/U4/dialogs/dialog-playground.tsx",
      "--outfile",
      "dist/u4-3-dialog-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the U4.3 playground.");
  writeFileSync(
    join(DIST_ROOT, "u4-3-dialog-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp U4.3 dialog playground</title>
  </head>
  <body>
    <div id="u4-3-playground-root"></div>
    <script type="module" src="/u4-3-dialog-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(buildPlaygroundPage);

test("renders select, confirm, input, editor and Ask with token-backed Button styles", async ({
  page,
}) => {
  await page.goto("/u4-3-dialog-playground.html");
  const button = page.locator('[data-slot="button"]').first();
  await expect(button).toBeVisible();
  const buttonStyle = await button.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { borderRadius: computed.borderRadius, backgroundColor: computed.backgroundColor };
  });
  expect(buttonStyle.borderRadius).not.toBe("0px");
  expect(buttonStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

  await page.locator("#open-select").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("option", { name: /Beryl/ }).click();
  await page.getByRole("button", { name: "Choose" }).click();
  await expect(page.locator('[data-testid="last-answer"]')).toContainText("Beryl");
  await page.screenshot({ path: "../../.data/screenshots/u4-3-select-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto("/u4-3-dialog-playground.html");
  await darkPage.locator("#open-confirm").click();
  const deny = darkPage.getByRole("button", { name: "Deny" });
  await expect(deny).toBeFocused();
  // The dialog's open transition must finish before colors are read: await it, never a fixed wait.
  await darkPage.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  const contrast = await darkPage.getByRole("button", { name: "Cancel" }).evaluate((element) => {
    const parse = (value: string) => {
      const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
      if (value.trim().startsWith("oklch")) {
        const [lightness = 0, chroma = 0, hue = 0] = numbers;
        const angle = (hue * Math.PI) / 180;
        const a = chroma * Math.cos(angle);
        const b = chroma * Math.sin(angle);
        const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
        const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
        const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
        const toSrgb = (channel: number) => {
          const value = 1.055 * Math.sign(channel) * Math.abs(channel) ** (1 / 2.4) - 0.055;
          return Math.max(0, Math.min(255, value * 255));
        };
        return {
          red: toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
          green: toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          blue: toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
          alpha: 1,
        };
      }
      const alpha = value.startsWith("rgba") ? (numbers[3] ?? 1) : 1;
      return { red: numbers[0] ?? 0, green: numbers[1] ?? 0, blue: numbers[2] ?? 0, alpha };
    };
    const linear = (value: number) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    };
    const text = parse(getComputedStyle(element).color);
    let background = parse(getComputedStyle(element).backgroundColor);
    let parent = element.parentElement;
    while (background.alpha < 1 && parent) {
      const underneath = parse(getComputedStyle(parent).backgroundColor);
      background = {
        red: background.red * background.alpha + underneath.red * (1 - background.alpha),
        green: background.green * background.alpha + underneath.green * (1 - background.alpha),
        blue: background.blue * background.alpha + underneath.blue * (1 - background.alpha),
        alpha: underneath.alpha,
      };
      parent = parent.parentElement;
    }
    const textLuminance =
      0.2126 * linear(text.red) + 0.7152 * linear(text.green) + 0.0722 * linear(text.blue);
    const backgroundLuminance =
      0.2126 * linear(background.red) +
      0.7152 * linear(background.green) +
      0.0722 * linear(background.blue);
    const ratio =
      (Math.max(textLuminance, backgroundLuminance) + 0.05) /
      (Math.min(textLuminance, backgroundLuminance) + 0.05);
    return { ratio, text, background };
  });
  expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
  await darkPage.screenshot({
    path: "../../.data/screenshots/u4-3-confirm-dark.png",
    fullPage: true,
  });
  await darkPage.keyboard.press("Escape");
  await expect(darkPage.locator('[data-overlay-kind="modal"]')).toHaveCount(0);
  await darkPage.close();

  await page.locator("#open-input").click();
  await page.getByRole("textbox", { name: "Project name" }).fill("omp");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator('[data-testid="last-answer"]')).toContainText("omp");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../../.data/screenshots/u4-3-input-narrow.png", fullPage: true });

  await page.locator("#open-editor").click();
  const editor = page.getByRole("textbox", { name: "Edit notes" });
  await editor.fill("Edited notes");
  await editor.press("Control+Enter");
  await expect(page.locator('[data-testid="last-answer"]')).toContainText("Edited notes");
  await page.screenshot({ path: "../../.data/screenshots/u4-3-editor-narrow.png", fullPage: true });

  await page.locator("#open-ask").click();
  await page.getByRole("radio", { name: "Fast" }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator('[data-testid="last-answer"]')).toContainText("Fast");
  await page.screenshot({ path: "../../.data/screenshots/u4-3-ask-narrow.png", fullPage: true });
});
