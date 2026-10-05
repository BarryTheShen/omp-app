/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PLAYGROUND = "/d3-login-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D3/auth/playground.tsx",
      "--outdir",
      "dist/d3-login-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for D3 login.");
  writeFileSync(
    join(DIST_ROOT, "d3-login-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div id="d3-login-playground-root"></div>
    <script type="module" src="/d3-login-playground/playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => buildPlaygroundPage());

test("renders provider discovery and OAuth handoff states in light dark and narrow layouts", async ({
  page,
}) => {
  await page.goto(PLAYGROUND);
  await expect(page.getByTestId("d3-provider-login")).toBeVisible();
  await expect(page.getByText("Provider A")).toBeVisible();
  await expect(page.getByText("Provider C")).toBeVisible();
  await expect(page.getByText(/Sign-in opens in a new tab/i)).toBeVisible();
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  const style = await page.getByTestId("d3-provider-login").evaluate((node) => {
    const computed = getComputedStyle(node);
    return { background: computed.backgroundColor, font: computed.fontFamily };
  });
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.font).toMatch(/ui|sans/i);
  await page.getByRole("button", { name: "Log in" }).first().click();
  await expect(page.getByTestId("d3-login-status")).toContainText("Authenticated");
  await page.screenshot({ path: "../../.data/screenshots/d3.2-login-light.png", fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto(PLAYGROUND);
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByTestId("d3-provider-login")).toBeVisible();
  await darkPage.screenshot({
    path: "../../.data/screenshots/d3.2-login-dark.png",
    fullPage: true,
  });
  await darkPage.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../../.data/screenshots/d3.2-login-narrow.png", fullPage: true });
});
