/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const playground = "/p2-3-review-playground.html";

function buildPlaygroundPage(): void {
  mkdirSync(join(APP_ROOT, ".data"), { recursive: true });
  mkdirSync(join(APP_ROOT, "..", "..", ".data", "screenshots"), { recursive: true });
  rmSync(join(APP_ROOT, ".data", "p2-3-review-playground.js"), { force: true });
  rmSync(join(DIST_ROOT, "p2-3-review-playground"), { force: true, recursive: true });
  rmSync(join(DIST_ROOT, "p2-3-review-playground.html"), { force: true });
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P2/review/playground.tsx",
      "--outdir",
      "dist/p2-3-review-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) {
    throw new Error("The production build did not emit a stylesheet for the P2.3 playground.");
  }
  writeFileSync(
    join(DIST_ROOT, "p2-3-review-playground.html"),
    `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp plan review playground</title>
  </head>
  <body>
    <div id="p2-review-playground-root"></div>
    <script type="module" src="/p2-3-review-playground/playground.js"></script>
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

test.describe("P2.3 PlanReviewPanel playground", () => {
  test("captures light, dark and narrow plan review layouts", async ({ page }) => {
    await page.addInitScript(() => document.documentElement.classList.add("dark"));
    await page.goto(playground);
    const panel = page.getByRole("region", { name: "Plan review" });
    const navigation = page.getByRole("navigation", { name: "Plan headings" });
    const newUpdates = page.getByRole("button", { name: "New updates" });
    await expect(panel).toBeVisible();
    await expect(navigation.getByRole("button")).toHaveCount(8);
    await expect(newUpdates).toHaveCount(0);
    const darkBackground = await page
      .getByTestId("p2-review-playground")
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    await expect(newUpdates).toHaveCount(0);
    await page.screenshot({ path: "../../.data/screenshots/p2.3-review-dark.png", fullPage: true });

    await page.getByTestId("theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    const lightBackground = await page
      .getByTestId("p2-review-playground")
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(lightBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(lightBackground).not.toBe(darkBackground);
    await expect(newUpdates).toHaveCount(0);
    await page.screenshot({
      path: "../../.data/screenshots/p2.3-review-light.png",
      fullPage: true,
    });

    await page.getByTestId("theme-dark").click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toHaveAttribute("data-panel-layout", "drawer");
    await expect(navigation.getByRole("button")).toHaveCount(8);
    await expect(newUpdates).toHaveCount(0);
    const narrowBackground = await page
      .getByTestId("p2-review-playground")
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(narrowBackground).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({
      path: "../../.data/screenshots/p2.3-review-390.png",
      fullPage: true,
    });
  });
  test("navigates and reports actions without a false update notice", async ({ page }) => {
    await page.addInitScript(() => document.documentElement.classList.add("dark"));
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(playground);
    const panel = page.getByRole("region", { name: "Plan review" });
    const navigation = page.getByRole("navigation", { name: "Plan headings" });
    const updates = page.getByRole("button", { name: "New updates" });
    const scroller = page.locator("[data-plan-review-scroll]");
    await expect(panel).toBeVisible();
    await expect(navigation.getByRole("button")).toHaveCount(8);
    await expect(updates).toHaveCount(0);

    await page
      .getByRole("navigation", { name: "Plan headings" })
      .getByRole("button", { name: "Goals" })
      .click();
    const goals = page.getByRole("region", { name: "Heading: Goals" });
    await expect(goals).toBeFocused();
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Copy plan" }).click();
    await expect(page.getByText("Plan copied.")).toBeVisible();
    await expect(updates).toHaveCount(0);

    const downloadStarted = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export plan" }).click();
    const download = await downloadStarted;
    expect(download.suggestedFilename()).toBe("plan.md");
    await expect(page.getByText("Plan exported.")).toBeVisible();
    await expect(updates).toHaveCount(0);
  });
});
