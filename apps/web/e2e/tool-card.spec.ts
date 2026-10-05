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
      "src/modules/U3/tool-card/card-playground.tsx",
      "--outdir",
      "dist/u3-card-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the tool-card playground.");
  writeFileSync(
    join(DIST_ROOT, "u3-card-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/u3-card-playground/card-playground.js"></script>
  </head>
  <body>
    <div id="u3-card-playground-root"></div>
  </body>
</html>
`,
  );
}

function channelLuminance(color: number[]): number {
  const channels = color.map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("renders every ToolCard state and captures light/dark/narrow screenshots", async ({
  page,
}) => {
  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await page.goto("/u3-card-playground.html");
  await expect(page.getByTestId("u3-card-playground")).toBeVisible();
  for (const phase of ["running", "partial", "success", "error", "cancelled"]) {
    await expect(page.getByTestId(`tool-state-chip-${phase}`)).toBeVisible();
  }
  await page.screenshot({ path: "../../.data/screenshots/u3.2-card-light.png", fullPage: true });

  await darkPage.goto("/u3-card-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  const chipColors = await darkPage.getByTestId("tool-state-chip-error").evaluate((element) => {
    const style = getComputedStyle(element);
    const pageStyle = getComputedStyle(document.querySelector("main") as HTMLElement);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable");
    const sample = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    return {
      foreground: sample(style.color),
      background: sample(style.backgroundColor),
      pageBackground: sample(pageStyle.backgroundColor),
    };
  });
  const foreground = channelLuminance(chipColors.foreground);
  const background = channelLuminance(chipColors.background);
  const contrast =
    (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  expect(channelLuminance(chipColors.pageBackground)).toBeLessThan(0.3);
  await darkPage.screenshot({ path: "../../.data/screenshots/u3.2-card-dark.png", fullPage: true });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../../.data/screenshots/u3.2-card-narrow.png", fullPage: true });
});
