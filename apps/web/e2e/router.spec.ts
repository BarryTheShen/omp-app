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
      "src/modules/U4/router/router-playground.tsx",
      "--outfile",
      "dist/u4-5-router-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the U4.5 playground.");
  writeFileSync(
    join(DIST_ROOT, "u4-5-router-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp U4.5 router playground</title>
  </head>
  <body>
    <div id="u4-5-playground-root"></div>
    <script type="module" src="/u4-5-router-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(buildPlaygroundPage);

test("presents safe OAuth destination without auto-opening or leaking the URL", async ({
  page,
}) => {
  await page.goto("/u4-5-router-playground.html");
  const opener = page.locator("#open-oauth");
  await opener.click();
  const prompt = page.getByRole("dialog");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("accounts.example");
  await expect(prompt).not.toContainText("ephemeral");
  expect(page.context().pages()).toHaveLength(1);
  await page.screenshot({ path: "../../.data/screenshots/u4-5-oauth-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript({ content: 'document.documentElement.classList.add("dark")' });
  await darkPage.goto("/u4-5-router-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await darkPage.locator("#open-oauth").click();
  await expect(darkPage.getByRole("dialog")).toBeVisible();
  await darkPage.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  await darkPage.screenshot({
    path: "../../.data/screenshots/u4-5-oauth-dark.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator("#open-oauth").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: "../../.data/screenshots/u4-5-oauth-narrow.png", fullPage: true });
  await darkPage.close();
});
