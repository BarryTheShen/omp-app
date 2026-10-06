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
      "src/modules/S2/shell/playground-entry.tsx",
      "--outfile",
      "dist/s2-3-sections-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css)
    throw new Error("The production build did not emit an index stylesheet for S2.3 sections.");
  mkdirSync(SCREENSHOTS, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "s2-3-sections-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Files and Shell settings</title>
  </head>
  <body>
    <div id="s2-sections-playground-root"></div>
    <script type="module" src="/s2-3-sections-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectCardToken(page: Page, dark: boolean): Promise<void> {
  const card = page.getByTestId("settings-runtime-S2.filesLsp").locator("section[aria-labelledby]");
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

test("S2.3 sections render ConfigStore state and descriptor-backed apply reports", async ({
  page,
}) => {
  await page.goto("/s2-3-sections-playground.html");
  await expect(page.getByRole("heading", { name: "Files / LSP" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shell / Bash" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shell / Eval & Runtimes" })).toBeVisible();
  const reports = page.getByLabel("When settings take effect");
  await expect(reports).toHaveCount(3);
  await expect(reports.nth(0)).toContainText("Reload required: Lazy LSP Startup");
  await expect(reports.nth(0)).toContainText("Live: LSP, Shared Language Servers");
  await expect(reports.nth(1)).toContainText("Live: Bash, Allow Compound Commands");
  await expect(reports.nth(2)).toContainText("Live: Python Eval Backend");
  await expect(page.getByText("Source: global").first()).toBeVisible();
  await expectCardToken(page, false);
  await page.screenshot({ path: join(SCREENSHOTS, "s2.3-sections-light.png"), fullPage: true });

  const dark = await page.context().newPage();
  await dark.emulateMedia({ colorScheme: "dark" });
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto("/s2-3-sections-playground.html?theme=dark");
  await expect(dark.locator("html")).toHaveClass(/dark/);
  await expect(dark.getByRole("heading", { name: "Files / LSP" })).toBeVisible();
  await expectCardToken(dark, true);
  await dark.screenshot({ path: join(SCREENSHOTS, "s2.3-sections-dark.png"), fullPage: true });

  await dark.setViewportSize({ width: 390, height: 844 });
  await expect(dark.getByRole("heading", { name: "Shell / Eval & Runtimes" })).toBeVisible();
  await expectCardToken(dark, true);
  const dimensions = await dark.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await dark.screenshot({ path: join(SCREENSHOTS, "s2.3-sections-narrow.png"), fullPage: true });
  await dark.locator("html").evaluate((element) => {
    (element as HTMLElement).style.zoom = "200%";
  });
  await expect(dark.getByRole("heading", { name: "Shell / Eval & Runtimes" })).toBeVisible();
  const zoomedDimensions = await dark.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(zoomedDimensions.content).toBeLessThanOrEqual(zoomedDimensions.viewport);
  await dark.close();
});
