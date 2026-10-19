/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { narrowTo, openAllToolCards } from "./real-omp";

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

test.beforeAll(() => ensurePlaygroundBuilt(buildMemoryPlayground));

test("renders all T6 memory cards in light, dark and narrow states", async ({ page }) => {
  await page.goto("/t6-memory-playground.html");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.getByText("Scrubbed query 2")).toBeVisible();
  await openAllToolCards(page);
  await expect(
    page.getByText("Found 22 relevant memories (as of 2026-10-07 21:44 UTC):", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Showing 8 of 22 memories.")).toBeVisible();
  const recallCard = page.locator('[data-t6-tool="recall"]');
  await expect(recallCard).toContainText("Showing 8 of 22 memories.");
  await recallCard.screenshot({ path: "../../.data/screenshots/t6-recall-count-light.png" });
  await expect(page.getByRole("heading", { name: "Synthesis" })).toBeVisible();
  await expect(
    page
      .locator('[data-t6-tool="reflect"]')
      .getByText("Collaboration remains capability-gated.")
      .first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-t6-tool="learn"]').getByText("Memory lesson · project"),
  ).toBeVisible();
  await expect(
    page.locator('[data-t6-tool="manage_skill"]').getByText('Updated managed skill "release".'),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release" })).toBeVisible();
  await expect(
    page
      .locator('[data-t6-tool="memory_edit"]')
      .getByText("Memory memory-1 was not found in bank project (working).", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Learned · project")).toHaveCount(0);
  await expect(page.getByText(/Confirmation: not_found/)).toHaveCount(0);
  await expect(page.getByText(/Status: updated/)).toHaveCount(0);
  const trigger = page.locator('[data-t6-tool="recall"] [data-slot="u3-tool-card-trigger"]');
  const lightStyles = await trigger.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { display: computed.display, color: computed.color, fontFamily: computed.fontFamily };
  });
  const monoToken = await page
    .locator("html")
    .evaluate((element) => getComputedStyle(element).getPropertyValue("--font-mono").trim());
  expect(monoToken).toContain("JetBrains Mono");
  expect(lightStyles.display).toBe("flex");
  expect(lightStyles.color).not.toBe("rgba(0, 0, 0, 0)");
  expect(lightStyles.fontFamily).toContain("JetBrains Mono");
  await expect(page.locator("li").first()).toBeVisible();
  const listStyle = await page
    .locator("li")
    .first()
    .evaluate((element) => getComputedStyle(element).listStyleType);
  expect(listStyle).not.toBe("none");
  await page.screenshot({
    path: "../../.data/screenshots/t6-2044-memory-labels-light.png",
    fullPage: false,
  });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto("/t6-memory-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await openAllToolCards(darkPage);
  const darkRecallCard = darkPage.locator('[data-t6-tool="recall"]');
  await expect(darkRecallCard).toContainText("Showing 8 of 22 memories.");
  await darkRecallCard.screenshot({ path: "../../.data/screenshots/t6-recall-count-dark.png" });
  const darkTrigger = darkPage.locator(
    '[data-t6-tool="memory_edit"] [data-slot="u3-tool-card-trigger"]',
  );
  const darkFont = await darkTrigger.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(darkFont).toContain("JetBrains Mono");
  await expect(darkPage.locator('[data-t6-tool="memory_edit"]')).toBeVisible();
  await darkPage.screenshot({
    path: "../../.data/screenshots/t6-2044-memory-labels-dark.png",
  });
  await narrowTo(darkPage);
  await openAllToolCards(darkPage);
  await expect(darkRecallCard).toContainText("Showing 8 of 22 memories.");
  await darkRecallCard.screenshot({ path: "../../.data/screenshots/t6-recall-count-390.png" });
  await darkPage.screenshot({
    path: "../../.data/screenshots/t6-2044-memory-labels-narrow.png",
  });
  await darkPage.close();
});
