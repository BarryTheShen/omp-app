/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const playground = "/t7-fallback-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T7/fallback-playground.tsx",
      "--outfile",
      "dist/t7-fallback-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error(
      "The production build did not emit a stylesheet for the T7 fallback playground.",
    );
  writeFileSync(
    join(DIST_ROOT, "t7-fallback-playground.html"),
    `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>omp T7 fallback playground</title>
  </head>
  <body>
    <div id="t7-fallback-playground-root"></div>
    <script type="module" src="/t7-fallback-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectStylesLoaded(page: Page): Promise<void> {
  const styles = await page.getByTestId("t7-fallback-playground").evaluate((node: HTMLElement) => {
    const computed = getComputedStyle(node);
    return { background: computed.backgroundColor, font: computed.fontFamily };
  });
  expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.font).not.toBe("");
}

function captureConsoleErrors(page: Page): string[] {
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

test.describe("T7 fallback", () => {
  test("renders safe unavailable fallback in dark and light themes", async ({ page }) => {
    const errors = captureConsoleErrors(page);
    await darkInit(page);
    await page.goto(playground);
    await expectStylesLoaded(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("alert")).toContainText("Host tools are unavailable");
    await expect(page.getByTestId("t7-fallback-arguments")).toContainText("operation");
    await page.screenshot({ path: "../../.data/screenshots/t7-fallback-dark.png", fullPage: true });

    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expectStylesLoaded(page);
    await page.getByRole("button", { name: "Show raw details" }).click();
    await expect(page.getByText("Raw details: object")).toBeVisible();
    await page.screenshot({
      path: "../../.data/screenshots/t7-fallback-light.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });

  test("reflows the fallback at narrow width without console errors", async ({ page }) => {
    const errors = captureConsoleErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await darkInit(page);
    await page.goto(playground);
    await expectStylesLoaded(page);
    await expect(page.getByTestId("t7-fallback-details")).toBeVisible();
    await page.screenshot({
      path: "../../.data/screenshots/t7-fallback-narrow.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
});
