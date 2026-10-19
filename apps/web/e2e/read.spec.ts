/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { openAllToolCards } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T1/read-playground.tsx",
      "--outdir",
      "dist/t1-read-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the read playground.");
  writeFileSync(
    join(DIST_ROOT, "t1-read-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/t1-read-playground/read-playground.js"></script>
  </head>
  <body>
    <div id="t1-read-playground-root"></div>
  </body>
</html>
`,
  );
}

test.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    buildPlaygroundPage();
  }),
);

test("renders read text, URL fallback and image states in light/dark/narrow layouts", async ({
  page,
}) => {
  await page.goto("/t1-read-playground.html");
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(page.getByTestId("t1-read-playground")).toBeVisible();
  await expect(page.getByTestId("t1-read-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await expect(page.getByTestId("t1-read-card")).toHaveCount(3);
  await openAllToolCards(page);
  await expect(page.getByText("export const answer = 42;").first()).toBeVisible();
  await expect.poll(() => distinctTokenColors(page, "[data-code-view]")).toBeGreaterThan(2);
  const lightCopy = page
    .locator("[data-code-view]")
    .getByRole("button", { name: "Copy code" })
    .first();
  expect(await iconContrast(page, lightCopy)).toBeGreaterThanOrEqual(3);
  await expect(page.getByText("URL renderer unavailable")).toBeVisible();
  await expect(page.getByRole("img", { name: "assets/logo.png" })).toBeVisible();
  await page.screenshot({ path: "../../.data/screenshots/t1.2-read-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto("/t1-read-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.getByTestId("t1-read-playground")).toBeVisible();
  await expect(darkPage.getByTestId("t1-read-card")).toHaveCount(3);
  await openAllToolCards(darkPage);
  await expect.poll(() => distinctTokenColors(darkPage, "[data-code-view]")).toBeGreaterThan(2);
  const darkCopy = darkPage
    .locator("[data-code-view]")
    .getByRole("button", { name: "Copy code" })
    .first();
  expect(await iconContrast(darkPage, darkCopy)).toBeGreaterThanOrEqual(3);
  await expect(darkPage.getByTestId("t1-read-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await darkPage.screenshot({ path: "../../.data/screenshots/t1.2-read-dark.png", fullPage: true });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => distinctTokenColors(page, "[data-code-view]")).toBeGreaterThan(2);
  await expect(page.getByTestId("t1-read-playground")).toHaveCSS(
    "background-color",
    /^(rgb|oklch)/,
  );
  await page.screenshot({ path: "../../.data/screenshots/t1.2-read-narrow.png", fullPage: true });
});

/** How many colours the highlighted tokens of a code block take: plain text would take one. */
async function distinctTokenColors(page: Page, scope: string): Promise<number> {
  return page
    .locator(`${scope} [data-code-token]`)
    .evaluateAll(
      (tokens) =>
        new Set(
          tokens
            .filter((token) => (token.textContent ?? "").trim() !== "")
            .map((token) => getComputedStyle(token).color),
        ).size,
    );
}

/**
 * The contrast ratio of an icon button's drawn pixels against the background behind it. The most
 * contrasting pixel of the button's screenshot stands for the icon and its top-left pixel for the
 * background, so antialiasing cannot lower the result.
 */
async function iconContrast(page: Page, button: Locator): Promise<number> {
  const png = await button.screenshot();
  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("The browser has no 2D canvas context.");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const luminance = (offset: number): number => {
      const linear = (channel: number | undefined): number => {
        const value = (channel ?? 0) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return (
        0.2126 * linear(data[offset]) +
        0.7152 * linear(data[offset + 1]) +
        0.0722 * linear(data[offset + 2])
      );
    };
    const background = luminance(0);
    let ratio = 1;
    for (let offset = 0; offset < data.length; offset += 4) {
      const pixel = luminance(offset);
      ratio = Math.max(
        ratio,
        (Math.max(pixel, background) + 0.05) / (Math.min(pixel, background) + 0.05),
      );
    }
    return ratio;
  }, png.toString("base64"));
}
