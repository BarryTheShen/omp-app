/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P7/context/playground-entry.tsx",
      "--outfile",
      "dist/p7-context-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit an index stylesheet for P7.");
  writeFileSync(
    join(DIST_ROOT, "p7-context-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>P7 context and usage</title>
  </head>
  <body>
    <div id="p7-context-playground-root"></div>
    <script type="module" src="/p7-context-playground.js"></script>
  </body>
</html>
`,
  );
}

async function assertStyled(page: Page): Promise<void> {
  const style = await page
    .getByRole("heading", { name: "Context and usage" })
    .evaluate((heading) => {
      const main = heading.closest("main");
      const card = main?.querySelector('[aria-labelledby="p7-context-meter-title"]');
      if (!card) throw new Error("P7 context card is missing");
      const cardStyle = getComputedStyle(card);
      return {
        background: cardStyle.backgroundColor,
        color: cardStyle.color,
        radius: cardStyle.borderRadius,
      };
    });
  expect(style.background).toMatch(/^(ok|rgb)/);
  expect(style.color).toMatch(/^(ok|rgb)/);
  expect(style.radius).not.toBe("0px");
}

test.beforeAll(() => buildPlayground());

test("shows context pressure, usage details and compaction controls", async ({ page }) => {
  await page.goto("/p7-context-playground.html");
  await expect(page.getByRole("heading", { name: "Context and usage" })).toBeVisible();
  // The full card for a panel …
  await expect(page.getByText("82,000 / 128,000 tokens")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: /context/i }).first()).toHaveAttribute(
    "aria-valuenow",
    "64.0625",
  );
  // … and the one-line status bar version.
  await expect(page.getByTestId("p7-status-line")).toContainText("82k of 128k tokens");
  await expect(page.getByRole("button", { name: "Compact now" })).toBeVisible();
  await page.getByRole("button", { name: /Usage/ }).click();
  await expect(page.getByText("Provider quota is unavailable from this host.")).toBeVisible();
  await assertStyled(page);
  await page.screenshot({
    path: "../../.data/screenshots/p7-2-context-usage-light.png",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto("/p7-context-playground.html?theme=dark");
  await expect(dark.locator("html")).toHaveClass("dark");
  await expect(dark.getByText("82,000 / 128,000 tokens")).toBeVisible();
  await dark.getByRole("button", { name: /Usage/ }).click();
  await expect(dark.getByText("Provider quota is unavailable from this host.")).toBeVisible();
  await assertStyled(dark);
  await dark.screenshot({
    path: "../../.data/screenshots/p7-2-context-usage-dark.png",
    fullPage: true,
  });
  await dark.getByRole("button", { name: /Usage/ }).click();
  await dark.setViewportSize({ width: 390, height: 844 });
  await dark.screenshot({
    path: "../../.data/screenshots/p7-2-context-usage-narrow.png",
    fullPage: true,
  });
  await dark.close();
});
