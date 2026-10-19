/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/overlay/overlay-playground.tsx",
      "--outfile",
      "dist/overlay-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the overlay playground.");
  writeFileSync(
    join(DIST_ROOT, "overlay-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>omp overlay playground</title>
  </head>
  <body>
    <div id="overlay-playground-root"></div>
    <script type="module" src="/overlay-playground.js"></script>
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

test("modal opens over the shell, traps focus, locks scroll, and restores its opener", async ({
  page,
}) => {
  await page.goto("/overlay-playground.html");
  const opener = page.locator("#modal-opener");
  await opener.focus();
  await opener.click();

  const modal = page.getByRole("dialog", { name: "Approval dialog" });
  await expect(modal).toBeVisible();
  await expect(page.locator('[data-overlay-kind="modal"]').first()).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await expect(page.locator('[data-testid="modal-body"] button').first()).toBeFocused();
  await page.screenshot({ path: "../../.data/screenshots/u0-4-modal-light.png", fullPage: true });

  await page.locator("html").evaluate((element) => element.classList.add("dark"));
  await page.screenshot({ path: "../../.data/screenshots/u0-4-modal-dark.png", fullPage: true });

  await page.keyboard.press("Escape");
  await expect(page.locator('[data-overlay-kind="modal"]')).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("popover closes from the top of the stack and returns focus at a narrow width", async ({
  page,
}) => {
  await page.goto("/overlay-playground.html");
  const opener = page.locator("#popover-opener");
  await opener.focus();
  await opener.click();

  const popover = page.getByRole("dialog");
  await expect(popover).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../../.data/screenshots/u0-4-popover-narrow.png",
    fullPage: true,
  });

  await page.keyboard.press("Escape");
  await expect(page.locator('[data-overlay-kind="popover"]')).toHaveCount(0);
  await expect(opener).toBeFocused();
});
