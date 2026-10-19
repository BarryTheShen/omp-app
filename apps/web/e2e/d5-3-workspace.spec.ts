/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");

function playgroundHtml(css: string, theme: "light" | "dark"): string {
  const themeClass = theme === "dark" ? ' class="dark"' : "";
  return `<!doctype html>
<html lang="en"${themeClass}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp D5.3 workspace playground</title>
  </head>
  <body>
    <div id="d5-3-workspace-playground-root"></div>
    <script type="module" src="/d5-3-workspace-playground.js"></script>
  </body>
</html>
`;
}

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D5/workspace/workspace-playground.tsx",
      "--outfile",
      "dist/d5-3-workspace-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for D5.3 workspace.");
  for (const theme of ["light", "dark"] as const) {
    writeFileSync(
      join(DIST_ROOT, `d5-3-workspace-${theme === "dark" ? "dark-" : ""}playground.html`),
      playgroundHtml(css, theme),
    );
  }
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
}

async function expectTokenStyles(page: Page): Promise<string> {
  const panel = page.getByTestId("workspace-panel");
  const style = await panel.evaluate((element) => {
    const tokenProbe = document.createElement("span");
    tokenProbe.style.color = "var(--foreground)";
    document.body.append(tokenProbe);
    const tokenColor = getComputedStyle(tokenProbe).color;
    tokenProbe.remove();
    const button = element.querySelector('[data-slot="button"]');
    if (!button) throw new Error("Workspace panel has no shared Button.");
    const buttonStyle = getComputedStyle(button);
    return {
      foreground: getComputedStyle(element).color,
      tokenColor,
      buttonRadius: buttonStyle.borderRadius,
      buttonColor: buttonStyle.color,
    };
  });
  expect(style.foreground).toBe(style.tokenColor);
  expect(style.buttonRadius).not.toBe("0px");
  expect(style.buttonColor).toBe(style.tokenColor);
  return style.foreground;
}

function capturePageErrors(page: Page, errors: string[]): void {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

test("renders workspace controls with light, dark, narrow and local U4 dialog states", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  capturePageErrors(page, consoleErrors);
  await page.goto("/d5-3-workspace-playground.html");
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await expect(page.getByTestId("workspace-path")).toContainText("/workspaces/omp-app");
  await expect(page.getByText("Worktree relocation isn't available in the app yet.")).toBeVisible();
  const lightForeground = await expectTokenStyles(page);
  await page.screenshot({
    path: "../../.data/screenshots/d5-3-workspace-light.png",
    fullPage: true,
  });

  const darkPage = await page.context().newPage();
  capturePageErrors(darkPage, consoleErrors);
  await darkPage.goto("/d5-3-workspace-dark-playground.html");
  await expect(darkPage.locator("html")).toHaveClass(/\bdark\b/);
  await darkPage.getByRole("button", { name: "Move session" }).click();
  const folderDialog = darkPage.getByRole("dialog");
  await expect(folderDialog).toBeVisible();
  await expect(
    folderDialog.getByRole("heading", { name: "Choose an existing folder" }),
  ).toBeVisible();
  await darkPage.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
  const darkForeground = await expectTokenStyles(darkPage);
  expect(darkForeground).not.toBe(lightForeground);
  await darkPage.screenshot({
    path: "../../.data/screenshots/d5-3-workspace-dark.png",
    fullPage: true,
  });
  await darkPage.keyboard.press("Escape");
  await expect(darkPage.locator('[data-overlay-kind="modal"]')).toHaveCount(0);
  await darkPage.close();

  await page.getByRole("button", { name: "Move session" }).click();
  await page.getByRole("option", { name: "Choose another existing folder…" }).click();
  await page.getByRole("button", { name: "Choose" }).click();
  const pathInput = page.getByRole("textbox", { name: "Move to an existing folder" });
  await expect(pathInput).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectTokenStyles(page);
  await page.screenshot({
    path: "../../.data/screenshots/d5-3-workspace-narrow.png",
    fullPage: true,
  });
  await pathInput.fill("/workspaces/another-project");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("workspace-notice")).toContainText("Ready to move the session");
  expect(consoleErrors).toEqual([]);
});
