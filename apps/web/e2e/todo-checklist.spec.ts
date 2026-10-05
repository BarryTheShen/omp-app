/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const playground = "/u5-todo-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U5/todo/checklist/playground.tsx",
      "--outfile",
      "dist/u5-todo-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the U5.4 playground.");
  writeFileSync(
    join(DIST_ROOT, "u5-todo-playground.html"),
    `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
  </head>
  <body>
    <div id="u5-todo-playground-root"></div>
    <script type="module" src="/u5-todo-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectStylesLoaded(page: Page): Promise<void> {
  const styles = await page.getByTestId("todo-playground").evaluate((node: HTMLElement) => {
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

test.beforeAll(() => {
  buildPlaygroundPage();
});

test.describe("U5.4 todo checklist and tool card", () => {
  test("renders the dark-start tool card and light checklist with loaded tokens", async ({
    page,
  }) => {
    const consoleErrors = captureConsoleErrors(page);
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
    await page.goto(playground);
    await expectStylesLoaded(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByText("Updated todos: 3 of 7 done")).toBeVisible();
    await expect(page.getByTestId("todo-checklist").first()).toBeVisible();
    await expect(
      page.locator('[data-u0-right-sidebar] [data-panel-layout="sidebar"]'),
    ).toBeVisible();
    await expect(
      page.locator("[data-u0-right-sidebar]").getByRole("button", { name: "Collapse Build" }),
    ).toBeVisible();
    await page.screenshot({ path: "../../.data/screenshots/u5.4-ready-dark.png", fullPage: true });

    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expectStylesLoaded(page);
    await expect(page.getByText("Updated todos: 3 of 7 done")).toBeVisible();
    await page.screenshot({ path: "../../.data/screenshots/u5.4-ready-light.png", fullPage: true });
    expect(consoleErrors).toEqual([]);
  });

  test("shows the PanelShell drawer and tool card at narrow width", async ({ page }) => {
    const consoleErrors = captureConsoleErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
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
    await page.goto(playground);
    await expectStylesLoaded(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    const panel = page.locator('[data-u0-right-sidebar] [data-panel-layout="drawer"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("todo-checklist")).toBeVisible();
    await expect(page.getByText("Updated todos: 3 of 7 done")).toBeVisible();
    await page.screenshot({ path: "../../.data/screenshots/u5.4-narrow-dark.png", fullPage: true });
    expect(consoleErrors).toEqual([]);
  });
});
