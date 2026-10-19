/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOTS = join(APP_ROOT, "../../.data/screenshots");
const playground = "/i4-collaboration-playground.html";

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/I4/collab/playground.tsx",
      "--outfile",
      "dist/i4-collaboration-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The app build did not emit the collaboration panel stylesheet.");
  mkdirSync(SCREENSHOTS, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "i4-collaboration-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <script>
      if (location.search.includes("dark")) document.documentElement.classList.add("dark");
    </script>
    <title>omp collaboration panel</title>
  </head>
  <body>
    <div id="i4-collaboration-playground-root"></div>
    <script type="module" src="/i4-collaboration-playground.js"></script>
  </body>
</html>
`,
  );
}

async function expectSidebarToken(page: Page): Promise<void> {
  const colors = await page.locator('[data-u0-right-sidebar="true"]').evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--sidebar)";
    document.body.append(probe);
    const value = {
      actual: getComputedStyle(element).backgroundColor,
      token: getComputedStyle(probe).backgroundColor,
    };
    probe.remove();
    return value;
  });
  expect(colors.actual).toBe(colors.token);
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

test.describe("I4.3 collaboration panel", () => {
  test("shows unavailable controls in light and dark themes", async ({ page }) => {
    await page.goto(playground);
    const panel = page.getByRole("region", { name: "Collaboration" });
    await expect(panel).toBeVisible();
    await expect(page.getByRole("button", { name: "Host a session" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Create a view link" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Join a session" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Leave the session" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Stop sharing" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Copy sharing link" })).toBeDisabled();
    await expect(
      page.getByText(
        "Every action is unavailable because omp only offers collaboration in its terminal.",
      ),
    ).toHaveCount(1);
    await expectSidebarToken(page);
    await page.screenshot({
      path: join(SCREENSHOTS, "i4.3-collaboration-light.png"),
      fullPage: true,
    });

    const darkPage = await page.context().newPage();
    await darkPage.goto(`${playground}?dark`);
    const darkPanel = darkPage.getByRole("region", { name: "Collaboration" });
    await expect(darkPanel).toBeVisible();
    await expect(darkPage.locator("html")).toHaveClass(/dark/);
    await expectSidebarToken(darkPage);
    await darkPage.screenshot({
      path: join(SCREENSHOTS, "i4.3-collaboration-dark.png"),
      fullPage: true,
    });
  });

  test("fits in a narrow viewport without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(playground);
    const panel = page.getByRole("region", { name: "Collaboration" });
    await expect(panel).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
    await expectSidebarToken(page);
    await page.screenshot({
      path: join(SCREENSHOTS, "i4.3-collaboration-390.png"),
      fullPage: true,
    });
  });
});
