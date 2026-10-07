/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D1/settings/playground-entry.tsx",
      "--outfile",
      "dist/d1-model-settings-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css)
    throw new Error("The production build did not emit an index stylesheet for D1 settings.");
  writeFileSync(
    join(DIST_ROOT, "d1-model-settings-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>
      if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");
    </script>
    <link rel="stylesheet" href="/assets/${css}" />
    <title>D1 model settings</title>
  </head>
  <body>
    <div id="d1-model-settings-playground-root"></div>
    <script type="module" src="/d1-model-settings-playground.js"></script>
  </body>
</html>
`,
  );
}

async function assertStyled(page: Page): Promise<void> {
  const evidence = await page
    .getByRole("heading", { name: "Model settings" })
    .evaluate((heading) => {
      const surface = heading.closest("main");
      const card = surface?.querySelector("section");
      const headingStyle = getComputedStyle(heading);
      const cardStyle = card ? getComputedStyle(card) : null;
      if (!cardStyle) throw new Error("model settings card is missing");
      return {
        background: cardStyle.backgroundColor,
        color: cardStyle.color,
        font: headingStyle.fontSize,
        radius: cardStyle.borderRadius,
      };
    });
  expect(evidence.background).toMatch(/^(ok|rgb)/);
  expect(evidence.color).toMatch(/^(ok|rgb)/);
  expect(evidence.font).toBe("20px");
  expect(evidence.radius).not.toBe("0px");
}

test.beforeAll(() => {
  buildPlaygroundPage();
});

test("renders six model settings sections with session/default provenance", async ({ page }) => {
  await page.goto("/d1-model-settings-playground.html");
  await expect(page.getByRole("heading", { name: "Model settings" })).toBeVisible();
  await expect(page.getByTestId("session-model")).toHaveText("alpha/reasoner-large");
  await expect(page.getByTestId("default-model")).toHaveText("alpha/fast-chat");
  for (const title of ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Prewalk", "Vision"])
    await expect(
      page.getByTestId(`model-settings-${title.toLowerCase().replaceAll(" ", "-")}`),
    ).toBeVisible();
  await expect(page.getByTestId("default-model-source")).toHaveText(
    "Source: Saved for all projects",
  );
  await assertStyled(page);
  await page.screenshot({
    path: "../../.data/screenshots/d1-5-model-settings-light.png",
    fullPage: true,
  });

  const dark = await page.context().newPage();
  await dark.addInitScript(() => document.documentElement.classList.add("dark"));
  await dark.goto("/d1-model-settings-playground.html?theme=dark");
  await expect(dark.locator("html")).toHaveClass("dark");
  await expect(dark.getByRole("heading", { name: "Model settings" })).toBeVisible();
  await assertStyled(dark);
  await dark.screenshot({
    path: "../../.data/screenshots/d1-5-model-settings-dark.png",
    fullPage: true,
  });
  await dark.setViewportSize({ width: 390, height: 844 });
  await dark.screenshot({
    path: "../../.data/screenshots/d1-5-model-settings-narrow.png",
    fullPage: true,
  });
  await dark.close();
});
