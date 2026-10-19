/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PLAYGROUND_DIST = join(DIST_ROOT, "u2.5-history");
const screenshots = path.resolve(APP_ROOT, "../../.data/screenshots");
const playground = "/u2.5-history.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/U2/history/playground.tsx",
      "--outdir",
      "dist/u2.5-history",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const js = readdirSync(PLAYGROUND_DIST).find((file) => file.endsWith(".js"));
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css || !js) throw new Error("The U2.5 playground bundle did not emit JS and root CSS.");
  writeFileSync(
    join(DIST_ROOT, "u2.5-history.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>U2.5 history and editor</title>
  </head>
  <body>
    <div id="u2-history-playground-root"></div>
    <script type="module" src="/u2.5-history/${js}"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

async function assertStyled(page: Page): Promise<void> {
  const background = await page
    .getByTestId("u2-history-playground")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

test.describe("U2.5 history and external editor", () => {
  test("captures light history recall and unavailable editor state", async ({ page }) => {
    await page.goto(playground);
    await expect(page.getByTestId("u2-history-playground")).toBeVisible();
    await assertStyled(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("draft to restore");
    await input.press("Home");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("second historical prompt");
    await expect(page.getByRole("button", { name: "Open external editor" })).toBeDisabled();
    await page.screenshot({
      path: path.join(screenshots, "u2.5-light-history.png"),
      fullPage: true,
    });
  });
  test("captures the exact draft after leaving history browsing", async ({ page }) => {
    await page.goto(playground);
    await expect(page.getByTestId("u2-history-playground")).toBeVisible();
    await assertStyled(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("draft to restore");
    await input.press("Home");
    await input.press("ArrowUp");
    await expect(input).toHaveValue("second historical prompt");
    await input.press("End");
    await input.press("ArrowDown");
    await expect(input).toHaveValue("draft to restore");
    await page.screenshot({
      path: path.join(screenshots, "u2.5-light-history-restored.png"),
      fullPage: true,
    });
  });

  test("captures dark history state", async ({ page }) => {
    await page.addInitScript(() => document.documentElement.classList.add("dark"));
    await page.goto(`${playground}?theme=dark`);
    await expect(page.getByTestId("u2-history-playground")).toBeVisible();
    await expect(page.locator("html")).toHaveClass("dark");
    await assertStyled(page);
    await page.screenshot({
      path: path.join(screenshots, "u2.5-dark-history.png"),
      fullPage: true,
    });
  });

  test("keeps history and editor controls usable at a narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 760 });
    await page.goto(playground);
    await expect(page.getByTestId("u2-history-playground")).toBeVisible();
    await assertStyled(page);
    await expect(page.getByRole("button", { name: "Open external editor" })).toBeDisabled();
    await page.screenshot({
      path: path.join(screenshots, "u2.5-narrow-history.png"),
      fullPage: true,
    });
  });
});
