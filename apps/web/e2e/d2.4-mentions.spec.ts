/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PLAYGROUND_DIST = join(DIST_ROOT, "d2.4-mentions");
const screenshots = path.resolve(APP_ROOT, "../../.data/screenshots");
const playground = "/d2.4-mentions.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D2/mentions/playground.tsx",
      "--outdir",
      "dist/d2.4-mentions",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const js = readdirSync(PLAYGROUND_DIST).find((file) => file.endsWith(".js"));
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css || !js) throw new Error("The D2.4 playground bundle did not emit JS and root CSS.");
  writeFileSync(
    join(DIST_ROOT, "d2.4-mentions.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>D2.4 mentions</title>
  </head>
  <body>
    <div id="d2-mentions-playground-root"></div>
    <script type="module" src="/d2.4-mentions/${js}"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    buildPlaygroundPage();
  }),
);

async function assertStyled(page: Page): Promise<void> {
  const background = await page
    .getByTestId("d2-mentions-playground")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

test.describe("D2.4 mention trigger slot", () => {
  test("accepts @ file mentions through the real composer", async ({ page }) => {
    await page.goto(playground);
    await expect(page.getByTestId("d2-mentions-playground")).toBeVisible();
    await assertStyled(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("before @src");
    await input.press("ArrowDown");
    await expect(page.getByText("src/app.ts")).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "d2.4-light-file.png"), fullPage: true });
    await input.press("Enter");
    await expect(input).toHaveValue("before @src/app.ts ");
    await expect(page.getByTestId("mention-selection")).toHaveText("src/app.ts");
  });

  test("accepts GitHub references and captures a dark screenshot", async ({ page }) => {
    await page.addInitScript(() => document.documentElement.classList.add("dark"));
    await page.goto(`${playground}?theme=dark`);
    await expect(page.getByTestId("d2-mentions-playground")).toBeVisible();
    await expect(page.locator("html")).toHaveClass("dark");
    await assertStyled(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("see #123");
    await input.press("ArrowDown");
    await expect(page.getByText("pr #123")).toBeVisible();
    await expect(page.getByText("Fix completion · open")).toBeVisible();
    await expect(page.getByText("issue #123")).toBeVisible();
    await expect(page.getByText("Bug report · closed")).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "d2.4-dark-github.png"), fullPage: true });
    await page.getByText("issue #123").click();
    await expect(input).toHaveValue("see issue://123 ");
  });

  test("keeps the popover usable at a narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 760 });
    await page.goto(playground);
    await expect(page.getByTestId("d2-mentions-playground")).toBeVisible();
    await assertStyled(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("@src");
    await input.press("ArrowDown");
    await expect(page.getByText("src/app.ts")).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "d2.4-narrow-file.png"), fullPage: true });
  });

  test("shows an unavailable row without losing the plain trigger", async ({ page }) => {
    await page.goto(playground);
    await expect(page.getByTestId("d2-mentions-playground")).toBeVisible();
    await assertStyled(page);
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("@none");
    await input.press("ArrowDown");
    await expect(page.getByText("Workspace file search is unavailable")).toBeVisible();
    await page.screenshot({ path: path.join(screenshots, "d2.4-unavailable.png"), fullPage: true });
  });
});
