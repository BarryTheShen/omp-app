/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildMemoryPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/T6/memory-playground.tsx",
      "--outdir",
      "dist/t6-memory-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for T6.");
  writeFileSync(
    join(DIST_ROOT, "t6-memory-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
  </head>
  <body>
    <div id="t6-memory-playground-root"></div>
    <script type="module" src="/t6-memory-playground/memory-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(() => buildMemoryPlayground());

test("renders recall and reflect cards in light, dark and narrow states", async ({ page }) => {
  await page.goto("/t6-memory-playground.html");
  await expect(page.locator('[data-t6-memory-card="true"]')).toHaveCount(2);
  await expect(page.getByText("prior release decision")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthesis" })).toBeVisible();
  await expect(page.getByText("Collaboration remains capability-gated.")).toBeVisible();
  const trigger = page.locator('[data-t6-tool="recall"] [data-slot="u3-tool-card-trigger"]');
  const lightStyles = await trigger.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { display: computed.display, color: computed.color };
  });
  expect(lightStyles.display).toBe("flex");
  expect(lightStyles.color).not.toBe("rgba(0, 0, 0, 0)");
  await expect(page.locator("li").first()).toBeVisible();
  const listStyle = await page
    .locator("li")
    .first()
    .evaluate((element) => getComputedStyle(element).listStyleType);
  expect(listStyle).not.toBe("none");
  await page.screenshot({ path: "../../.data/screenshots/t6-2-memory-light.png", fullPage: false });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto("/t6-memory-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkPage.getByRole("heading", { name: "Synthesis" })).toBeVisible();
  await expect(darkPage.locator('[data-t6-tool="reflect"]')).toBeVisible();
  await darkPage.screenshot({
    path: "../../.data/screenshots/t6-2-memory-dark.png",
    fullPage: false,
  });
  await darkPage.setViewportSize({ width: 390, height: 844 });
  await darkPage.screenshot({
    path: "../../.data/screenshots/t6-2-memory-narrow.png",
    fullPage: false,
  });
  await darkPage.close();
});
