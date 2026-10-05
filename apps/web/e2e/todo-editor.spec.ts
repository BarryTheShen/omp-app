/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const playground = "/u5-todo-editor-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U5/todo/editor/playground.tsx",
      "--outfile",
      "dist/u5-todo-editor-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error(
      "The production build did not emit a stylesheet for the U5.5 editor playground.",
    );
  writeFileSync(
    join(DIST_ROOT, "u5-todo-editor-playground.html"),
    `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>omp U5.5 todo editor playground</title>
  </head>
  <body>
    <div id="u5-todo-editor-playground-root"></div>
    <script type="module" src="/u5-todo-editor-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectStylesLoaded(page: Page): Promise<void> {
  const styles = await page.getByTestId("todo-editor-playground").evaluate((node: HTMLElement) => {
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

async function openEditor(page: Page): Promise<void> {
  await page.getByTestId("open-todo-editor").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Edit todo list" })).toHaveValue(/## Build/);
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test.describe("U5.5 todo Markdown editor", () => {
  test("opens U4 editor in dark-before-goto and light themes with loaded styles", async ({
    page,
  }) => {
    const consoleErrors = captureConsoleErrors(page);
    await darkInit(page);
    await page.goto(playground);
    await expectStylesLoaded(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await openEditor(page);
    await page.screenshot({ path: "../../.data/screenshots/u5.5-editor-dark.png", fullPage: true });

    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expectStylesLoaded(page);
    await openEditor(page);
    await page.screenshot({
      path: "../../.data/screenshots/u5.5-editor-light.png",
      fullPage: true,
    });
    expect(consoleErrors).toEqual([]);
  });

  test("keeps the U4 editor usable at a narrow width", async ({ page }) => {
    const consoleErrors = captureConsoleErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await darkInit(page);
    await page.goto(playground);
    await expectStylesLoaded(page);
    await openEditor(page);
    await expect(page.getByRole("textbox", { name: "Edit todo list" })).toBeVisible();
    await page.screenshot({
      path: "../../.data/screenshots/u5.5-editor-narrow-dark.png",
      fullPage: true,
    });
    expect(consoleErrors).toEqual([]);
  });
});
