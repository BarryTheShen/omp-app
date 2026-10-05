/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PLAYGROUND_DIST = join(DIST_ROOT, "t5.3-coordination");
const screenshots = path.resolve(APP_ROOT, "../../.data/screenshots");
const playground = "/t5.3-coordination.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T5/playground.tsx",
      "--outdir",
      "dist/t5.3-coordination",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const js = readdirSync(PLAYGROUND_DIST).find((file) => file.endsWith(".js"));
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css || !js) throw new Error("The T5.3 playground bundle did not emit JS and root CSS.");
  writeFileSync(
    join(DIST_ROOT, "t5.3-coordination.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>T5.3 coordination cards</title>
  </head>
  <body>
    <div id="t5-playground-root"></div>
    <script type="module" src="/t5.3-coordination/${js}"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

async function assertStyled(page: Page): Promise<void> {
  const background = await page
    .getByTestId("t5-playground")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

test.describe("T5.3 hub and wait coordination cards", () => {
  test("captures light hub jobs and IRC details", async ({ page }) => {
    await page.goto(playground);
    await expect(page.getByTestId("t5-playground")).toBeVisible();
    await assertStyled(page);
    await expect(page.getByText("alice → bob")).toBeVisible();
    await expect(page.getByText("Analyze", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "t5.3-light-hub.png"), fullPage: true });
  });

  test("captures dark wait counts and sealed state", async ({ page }) => {
    await page.addInitScript(() => document.documentElement.classList.add("dark"));
    await page.goto(`${playground}?theme=dark`);
    await expect(page.getByTestId("t5-playground")).toBeVisible();
    await expect(page.locator("html")).toHaveClass("dark");
    await assertStyled(page);
    await expect(page.getByTestId("t5-wait-counts")).toContainText("Sealed; still running");
    await expect(page.getByText("model-a", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "t5.3-dark-wait.png"), fullPage: true });
  });

  test("keeps cards readable at a narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 760 });
    await page.goto(playground);
    await expect(page.getByTestId("t5-playground")).toBeVisible();
    await assertStyled(page);
    await expect(page.getByTestId("t5-hub-card")).toBeVisible();
    await expect(page.getByTestId("t5-wait-card")).toBeVisible();
    await page.screenshot({
      path: path.join(screenshots, "t5.3-narrow-coordination.png"),
      fullPage: true,
    });
  });
});
