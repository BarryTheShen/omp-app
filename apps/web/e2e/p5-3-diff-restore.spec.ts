/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");

function buildPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P5/restore/playground.tsx",
      "--outfile",
      "dist/p5-3-restore.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error(
      "The production build did not emit a stylesheet for the P5 restore playground.",
    );
  for (const dark of [false, true]) {
    writeFileSync(
      join(DIST_ROOT, `p5-3-restore${dark ? "-dark" : ""}.html`),
      `<!doctype html>
<html lang="en"${dark ? ' class="dark"' : ""}>
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/assets/${css}" /><title>Restore preview</title></head>
<body><div id="p5-restore-root"></div><script type="module" src="/p5-3-restore.js"></script></body>
</html>`,
    );
  }
}

async function expectStyled(page: Page): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect
    .poll(() =>
      page.locator("main").evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .not.toBe("rgba(0, 0, 0, 0)");
}

async function captureState(
  browser: Browser,
  phase: "plan" | "confirmation" | "result",
  theme: "light" | "dark" | "narrow",
): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: theme === "narrow" ? 390 : 1280, height: 844 },
  });
  await page.goto(`/p5-3-restore${theme === "dark" ? "-dark" : ""}.html`);
  await expectStyled(page);
  if (phase !== "plan") {
    await page.getByRole("button", { name: "Review and restore" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Confirm Restore files and conversation" }),
    ).toBeVisible();
    await expect(page.getByText("workspace restore", { exact: true })).toHaveCount(0);
  }
  if (phase === "result") {
    await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("status")).toHaveText("Restore complete.");
    await expect(page.getByRole("button", { name: "Restore complete" })).toBeDisabled();
  }
  if (theme === "narrow") {
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  }
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, `p5-3-${phase}-${theme}.png`),
    fullPage: true,
  });
  await page.close();
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlayground));

test("restore plan, U4 confirmation and result are captured in light, dark and narrow themes", async ({
  browser,
}) => {
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  for (const phase of ["plan", "confirmation", "result"] as const) {
    for (const theme of ["light", "dark", "narrow"] as const)
      await captureState(browser, phase, theme);
  }
});
