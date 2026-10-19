/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
function buildPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D1/thinking/playground-entry.tsx",
      "--outfile",
      "dist/d1-thinking-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css)
    throw new Error("The production build did not emit an index stylesheet for D1 thinking.");
  writeFileSync(
    join(DIST_ROOT, "d1-thinking-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>D1 thinking</title>
  </head>
  <body>
    <div id="d1-thinking-playground-root"></div>
    <script type="module" src="/d1-thinking-playground.js"></script>
  </body>
</html>
`,
  );
}
async function assertStyled(page: Page): Promise<void> {
  const style = await page
    .getByRole("heading", { name: "Thinking level", exact: true })
    .evaluate((heading) => {
      const card = heading.closest("section");
      if (!card) throw new Error("thinking card is missing");
      const computed = getComputedStyle(card);
      return {
        background: computed.backgroundColor,
        color: computed.color,
        radius: computed.borderRadius,
      };
    });
  expect(style.background).toMatch(/^(ok|rgb)/);
  expect(style.color).toMatch(/^(ok|rgb)/);
  expect(style.radius).not.toBe("0px");
}
test.beforeAll(() => ensurePlaygroundBuilt(buildPlayground));
test("renders model-supported thinking levels and session scope", async ({ page }) => {
  await page.goto("/d1-thinking-playground.html");
  await expect(page.getByRole("heading", { name: "Thinking level" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Thinking: Medium/ })).toBeVisible();
  await page.getByRole("button", { name: "Thinking: Medium Model default" }).click();
  await expect(page.getByRole("option", { name: "Medium" })).toBeVisible();
  expect(await page.getByRole("option", { name: /Extra high/ }).isDisabled()).toBe(true);
  await page.screenshot({
    path: "../../.data/screenshots/d1-4-thinking-light.png",
    fullPage: true,
  });
  const dark = await page.context().newPage();
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto("/d1-thinking-playground.html?theme=dark");
  await expect(dark.locator("html")).toHaveClass("dark");
  await expect(dark.getByRole("button", { name: /Thinking: Medium/ })).toBeVisible();
  await dark.getByRole("button", { name: "Thinking: Medium Model default" }).click();
  await expect(dark.getByRole("option", { name: "Medium" })).toBeVisible();
  expect(await dark.getByRole("option", { name: /Max/ }).isDisabled()).toBe(true);
  await assertStyled(dark);
  await dark.screenshot({ path: "../../.data/screenshots/d1-4-thinking-dark.png", fullPage: true });
  await dark.setViewportSize({ width: 390, height: 844 });
  await dark.screenshot({
    path: "../../.data/screenshots/d1-4-thinking-narrow.png",
    fullPage: true,
  });
  await dark.close();
});
