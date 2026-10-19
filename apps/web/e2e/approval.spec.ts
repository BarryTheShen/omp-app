/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U4/approval/approval-playground.tsx",
      "--outfile",
      "dist/u4-4-approval-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the U4.4 playground.");
  writeFileSync(
    join(DIST_ROOT, "u4-4-approval-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp U4.4 approval playground</title>
  </head>
  <body>
    <div id="u4-4-playground-root"></div>
    <script type="module" src="/u4-4-approval-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

test("renders fail-closed approval decisions in light, dark and narrow Chrome states", async ({
  page,
}) => {
  await page.goto("/u4-4-approval-playground.html");
  await page.locator("#open-approval").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("option", { name: "Approve once" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Approve for this session" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Deny" })).toBeVisible();
  await page.screenshot({
    path: "../../.data/screenshots/u4-4-approval-light.png",
    fullPage: true,
  });
  await page.getByRole("option", { name: "Approve once" }).click();
  await page.getByRole("button", { name: "Choose" }).click();
  await expect(page.locator('[data-testid="last-decision"]')).toContainText("approved");

  await page.context().addInitScript({ content: 'document.documentElement.classList.add("dark")' });
  const darkPage = await page.context().newPage();
  await darkPage.goto("/u4-4-approval-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  const darkBackground = await darkPage
    .locator("main")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(darkBackground).toMatch(/oklch|rgb|hsl/);
  await darkPage.locator("#open-approval").click();
  await expect(darkPage.getByRole("option", { name: "Approve once" })).toBeVisible();
  await expect(darkPage.getByRole("option", { name: "Approve for this session" })).toBeVisible();
  await expect(darkPage.getByRole("option", { name: "Deny" })).toBeVisible();
  await darkPage.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  await darkPage.screenshot({
    path: "../../.data/screenshots/u4-4-approval-dark.png",
    fullPage: true,
  });
  await darkPage.getByRole("option", { name: "Deny" }).click();
  await darkPage.getByRole("button", { name: "Choose" }).click();
  await expect(darkPage.locator('[data-testid="last-decision"]')).toContainText("denied");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#open-approval").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: "../../.data/screenshots/u4-4-approval-narrow.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="last-decision"]')).toContainText("denied");
  await darkPage.close();
});
