/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildModePlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P6/modes/playground.tsx",
      "--outdir",
      "dist/p6-mode-playground",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for P6.");
  writeFileSync(
    join(DIST_ROOT, "p6-mode-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
  </head>
  <body>
    <div id="p6-mode-playground-root"></div>
    <script type="module" src="/p6-mode-playground/playground.js"></script>
  </body>
</html>
`,
  );
}
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

test.beforeAll(() => buildModePlayground());

test("renders session queue modes in light, dark and narrow states", async ({ page }) => {
  await page.goto("/p6-mode-playground.html");
  await page.getByRole("button", { name: "Queue modes" }).click();
  const dialog = page.getByRole("dialog", { name: "Queue modes" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog
      .getByRole("group", { name: "Steering mode" })
      .getByRole("button", { name: "One at a time" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog
      .getByRole("group", { name: "After this turn mode" })
      .getByRole("button", { name: "All" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByText("One at a time: deliver one queued steering message per tool boundary."),
  ).toBeVisible();
  await expect(dialog.getByText(/Stopping a turn \(Esc\)/)).toBeVisible();
  const dialogStyles = await dialog.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { background: computed.backgroundColor, borderRadius: computed.borderRadius };
  });
  expect(dialogStyles.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(dialogStyles.borderRadius).not.toBe("0px");
  await settleAnimations(page);
  await page.screenshot({ path: "../../.data/screenshots/p6-4-modes-light.png", fullPage: false });

  const darkPage = await page.context().newPage();
  await darkPage.addInitScript(() => document.documentElement.classList.add("dark"));
  await darkPage.goto("/p6-mode-playground.html");
  await darkPage.evaluate(() => document.documentElement.classList.add("dark"));
  await darkPage.getByRole("button", { name: "Queue modes" }).click();
  const darkDialog = darkPage.getByRole("dialog", { name: "Queue modes" });
  await expect(darkPage.locator("html")).toHaveClass(/dark/);
  await expect(darkDialog).toBeVisible();
  await settleAnimations(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/p6-4-modes-dark.png",
    fullPage: false,
  });
  await darkPage.setViewportSize({ width: 390, height: 844 });
  await settleAnimations(darkPage);
  await darkPage.screenshot({
    path: "../../.data/screenshots/p6-4-modes-narrow.png",
    fullPage: false,
  });
  await darkPage.close();
});
