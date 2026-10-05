/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const playground = "/u5-todo-reminder-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U5/todo/reminder/playground.tsx",
      "--outfile",
      "dist/u5-todo-reminder-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the U5.6 playground.");
  writeFileSync(
    join(DIST_ROOT, "u5-todo-reminder-playground.html"),
    `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>omp U5.6 reminder playground</title>
  </head>
  <body>
    <div id="u5-todo-reminder-playground-root"></div>
    <script type="module" src="/u5-todo-reminder-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectStylesLoaded(page: Page): Promise<void> {
  const styles = await page
    .getByTestId("todo-reminder-playground")
    .evaluate((node: HTMLElement) => {
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

test.describe("U5.6 todo reminders and board", () => {
  test("renders passive reminder and board in dark then light themes", async ({ page }) => {
    const errors = captureConsoleErrors(page);
    await darkInit(page);
    await page.goto(playground);
    await expectStylesLoaded(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByTestId("todo-reminder-notice")).toContainText("1 incomplete todo");
    await expect(page.getByTestId("todo-reminder-badge").first()).toHaveAccessibleName(/1/);
    await page.getByTestId("todo-mode-board").click();
    await expect(page.getByTestId("todo-board-columns")).toBeVisible();
    await page.screenshot({ path: "../../.data/screenshots/u5.6-board-dark.png", fullPage: true });

    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expectStylesLoaded(page);
    await expect(page.getByTestId("todo-reminder-badge").first()).toHaveAccessibleName(/1/);
    await page.screenshot({
      path: "../../.data/screenshots/u5.6-reminder-light.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });

  test("shows the retained previous list after auto-clear at narrow width", async ({ page }) => {
    const errors = captureConsoleErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await darkInit(page);
    await page.goto(playground);
    await expectStylesLoaded(page);
    await page.getByTestId("simulate-clear").click();
    await expect(page.getByTestId("todo-cleared-notice")).toContainText("Todos cleared");
    await expect(page.getByRole("button", { name: "View previous todos" })).toBeVisible();
    await page.screenshot({
      path: "../../.data/screenshots/u5.6-cleared-narrow-dark.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
});
