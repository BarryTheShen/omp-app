/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const playground = "/p2-mode-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P2/mode/playground.tsx",
      "--outfile",
      "dist/p2-mode-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for P2.2.");
  writeFileSync(
    join(DIST_ROOT, "p2-mode-playground.html"),
    `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>omp P2.2 plan mode</title>
  </head>
  <body>
    <div id="p2-mode-playground-root"></div>
    <script type="module" src="/p2-mode-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectStylesLoaded(page: Page): Promise<void> {
  const styles = await page.getByTestId("p2-mode-playground").evaluate((node: HTMLElement) => {
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

test.describe("P2.2 plan mode", () => {
  test("renders host status and capability reason in dark/light", async ({ page }) => {
    const errors = captureErrors(page);
    await darkInit(page);
    await page.goto(playground);
    await expectStylesLoaded(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByTestId("plan-mode-status")).toBeVisible();
    await expect(page.getByTestId("plan-mode-status")).toContainText(
      "can only be switched in the omp terminal",
    );
    await expect(page.getByTestId("plan-mode-toggle")).toBeDisabled();
    await page.screenshot({ path: "../../.data/screenshots/p2.2-mode-dark.png", fullPage: true });

    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expectStylesLoaded(page);
    await page.screenshot({ path: "../../.data/screenshots/p2.2-mode-light.png", fullPage: true });
    expect(errors).toEqual([]);
  });

  test("keeps the status readable at narrow width", async ({ page }) => {
    const errors = captureErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await darkInit(page);
    await page.goto(playground);
    await expectStylesLoaded(page);
    await expect(page.getByTestId("plan-mode-status")).toBeVisible();
    await expect(page.getByTestId("plan-mode-toggle")).toBeDisabled();
    await page.screenshot({ path: "../../.data/screenshots/p2.2-mode-narrow.png", fullPage: true });
    expect(errors).toEqual([]);
  });
});
