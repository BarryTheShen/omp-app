/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const playground = "/i2-extension-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/I2/extensions/playground.tsx",
      "--outfile",
      "dist/i2-extension-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for I2.2.");
  writeFileSync(
    join(DIST_ROOT, "i2-extension-playground.html"),
    `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>omp I2.2 Extension Control Center</title>
  </head>
  <body>
    <div id="i2-extension-playground-root"></div>
    <script type="module" src="/i2-extension-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectStylesLoaded(page: Page): Promise<void> {
  const styles = await page.getByTestId("i2-extension-playground").evaluate((node: HTMLElement) => {
    const computed = getComputedStyle(node);
    return { background: computed.backgroundColor, font: computed.fontFamily };
  });
  expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.font).not.toBe("");
}

function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function darkInit(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const root = document.documentElement;
    if (root) root.classList.add("dark");
    else
      document.addEventListener(
        "DOMContentLoaded",
        () => document.documentElement?.classList.add("dark"),
        { once: true },
      );
  });
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test.describe("I2.2 Extension Control Center", () => {
  test("renders tabs/search/inspector and light/dark styles", async ({ page }) => {
    const errors = captureErrors(page);
    await darkInit(page);
    await page.goto(playground);
    await expectStylesLoaded(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByTestId("extension-control-center")).toBeVisible();
    await page.getByTestId("extension-item-extension-two").click();
    await expect(page.getByTestId("extension-inspector")).toContainText("Review assistant");
    await page.getByTestId("extension-tab-skills").click();
    await expect(page.getByTestId("extension-item-skill-one")).toBeVisible();
    await page.getByTestId("extension-tab-plugins").click();
    await page.getByRole("textbox", { name: "Search extensions" }).fill("Release");
    await expect(page.getByTestId("extension-item-plugin-one")).toBeVisible();
    await page.getByTestId("extension-item-plugin-one").click();
    await expect(page.getByTestId("extension-inspector")).toContainText("demo-plugin");
    await page.screenshot({
      path: "../../.data/screenshots/i2.2-control-dark.png",
      fullPage: true,
    });

    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expectStylesLoaded(page);
    await page.screenshot({
      path: "../../.data/screenshots/i2.2-control-light.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });

  test("reflows to a narrow drawer and exposes unavailable state", async ({ page }) => {
    const errors = captureErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await darkInit(page);
    await page.goto(playground);
    await expectStylesLoaded(page);
    await expect(page.locator('[data-panel-layout="drawer"]')).toBeVisible();
    await page.getByTestId("extension-item-extension-two").click();
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
    await expect(page.getByTestId("extension-inspector")).toContainText("Review assistant");
    await page.screenshot({
      path: "../../.data/screenshots/i2.2-control-narrow.png",
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("extension-item-extension-two")).toBeVisible();
    await page.getByTestId("catalog-unavailable").click();
    await expect(page.getByTestId("extension-unavailable")).toContainText("unavailable");
    await expect(page.getByTestId("extension-tab-extensions")).toHaveCount(0);
    await page.screenshot({
      path: "../../.data/screenshots/i2.2-control-unavailable-narrow.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
});
