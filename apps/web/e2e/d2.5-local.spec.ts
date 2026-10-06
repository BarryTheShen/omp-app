/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PLAYGROUND_DIST = join(DIST_ROOT, "d2.5-local");
const screenshots = path.resolve(APP_ROOT, "../../.data/screenshots");
const playground = "/d2.5-local.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D2/local/playground.tsx",
      "--outdir",
      "dist/d2.5-local",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const js = readdirSync(PLAYGROUND_DIST).find((file) => file.endsWith(".js"));
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css || !js) throw new Error("The D2.5 playground bundle did not emit JS and root CSS.");
  writeFileSync(
    join(DIST_ROOT, "d2.5-local.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>D2.5 local triggers</title>
  </head>
  <body>
    <div id="d2-local-playground-root"></div>
    <script type="module" src="/d2.5-local/${js}"></script>
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
    .getByTestId("d2-local-playground")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

test.describe("D2.5 local trigger slot", () => {
  test("captures the open light emoji popover", async ({ page }) => {
    await page.goto(playground);
    await expect(page.getByTestId("d2-local-playground")).toBeVisible();
    await assertStyled(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("say :smil");
    await input.press("ArrowDown");
    await expect(page.getByText(/:smile:/)).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "d2.5-light-emoji.png"), fullPage: true });
  });

  test("captures the open dark internal URL popover", async ({ page }) => {
    await page.addInitScript(() => document.documentElement.classList.add("dark"));
    await page.goto(`${playground}?theme=dark`);
    await expect(page.getByTestId("d2-local-playground")).toBeVisible();
    await expect(page.locator("html")).toHaveClass("dark");
    await assertStyled(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("use skill://");
    await input.press("ArrowDown");
    await expect(page.getByText("Review skill")).toBeVisible();
    // After `skill://`, only skills are offered.
    await expect(page.getByText("Commit skill")).toBeVisible();
    await expect(page.getByText(/issue:\/\//)).toHaveCount(0);
    await page.evaluate(async () => {
      const finite = document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
      await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
    });
    await page.screenshot({ path: path.join(screenshots, "d2.5-dark-url.png"), fullPage: true });
  });

  test("keeps the emoji popover usable at a narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 760 });
    await page.goto(playground);
    await expect(page.getByTestId("d2-local-playground")).toBeVisible();
    await assertStyled(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill(":smil");
    await input.press("ArrowDown");
    await expect(page.getByText(/:smile:/)).toBeVisible();
    await page.screenshot({
      path: path.join(screenshots, "d2.5-narrow-emoji.png"),
      fullPage: true,
    });
  });
});
