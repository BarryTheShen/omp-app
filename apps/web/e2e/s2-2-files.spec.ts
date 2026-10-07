/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOTS = join(APP_ROOT, "../../.data/screenshots");

function normalizeColor(color: string): string {
  const normalizedPercentages = color.replace(/(\d+(?:\.\d+)?)%/gu, (_match, percentage: string) =>
    String(Number(percentage) / 100),
  );
  return normalizedPercentages.replace(/\b0\./gu, ".");
}

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/S2/files/playground-entry.tsx",
      "--outfile",
      "dist/s2-2-files-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css)
    throw new Error("The production build did not emit an index stylesheet for S2.2 Files.");
  mkdirSync(SCREENSHOTS, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "s2-2-files-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Files settings</title>
  </head>
  <body>
    <div id="s2-files-playground-root"></div>
    <script type="module" src="/s2-2-files-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectCardToken(page: Page, dark: boolean): Promise<void> {
  const card = page
    .getByTestId("settings-view-S2.filesEditing")
    .locator("section[aria-labelledby]");
  const colors = await card.evaluate((element, isDark) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const token = rootStyle
      .getPropertyValue(isDark ? "--omp-titanium-dark" : "--omp-light-card")
      .trim();
    return { background: getComputedStyle(element).backgroundColor, token };
  }, dark);
  expect(normalizeColor(colors.background)).toBe(normalizeColor(colors.token));
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("Files settings render ConfigStore provenance and dependent read-only controls", async ({
  page,
}) => {
  await page.goto("/s2-2-files-playground.html");
  await expect(page.getByRole("heading", { name: "Files / Editing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Files / Reading" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Files / Read Summaries" })).toBeVisible();
  await expect(page.getByTestId("read.defaultLimit-provenance")).toContainText(
    "Source: Saved for all projects",
  );
  await expect(
    page.getByText("Prevent changes to files that appear to be generated."),
  ).toBeVisible();
  await expect(
    page.getByText("This preference only changes omp's terminal; the app does not use it."),
  ).toBeVisible();
  await expect(page.getByText("Turn on Read Summaries to edit this setting.")).toHaveCount(6);
  await expectCardToken(page, false);
  await page.screenshot({ path: join(SCREENSHOTS, "s2.2-files-light.png"), fullPage: true });

  const dark = await page.context().newPage();
  await dark.emulateMedia({ colorScheme: "dark" });
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto("/s2-2-files-playground.html?theme=dark");
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await expect(dark.getByRole("heading", { name: "Files / Read Summaries" })).toBeVisible();
  await expect(dark.getByText("Turn on Read Summaries to edit this setting.")).toHaveCount(6);
  await expectCardToken(dark, true);
  await dark.screenshot({ path: join(SCREENSHOTS, "s2.2-files-dark.png"), fullPage: true });

  await dark.setViewportSize({ width: 390, height: 844 });
  await expect(dark.getByRole("heading", { name: "Files / Reading" })).toBeVisible();
  await expectCardToken(dark, true);
  const dimensions = await dark.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await dark.screenshot({ path: join(SCREENSHOTS, "s2.2-files-narrow.png"), fullPage: true });

  await dark.locator("html").evaluate((element) => {
    (element as HTMLElement).style.zoom = "200%";
  });
  const zoomed = await dark.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(zoomed.content).toBeLessThanOrEqual(zoomed.viewport);
  await dark.close();
});
