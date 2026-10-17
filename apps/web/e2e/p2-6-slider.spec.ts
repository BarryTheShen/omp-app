/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");

function buildPlayground(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P2/slider/playground.tsx",
      "--outfile",
      "dist/p2-6-slider.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The web build emitted no stylesheet.");
  writeFileSync(
    join(DIST_ROOT, "p2-6-slider.html"),
    `<!doctype html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><link rel="stylesheet" href="/assets/${css}"/></head><body><div id="p2-6-slider-playground-root"></div><script type="module" src="/p2-6-slider.js"></script></body></html>`,
  );
}

function sliderIn(page: Page, scene: string) {
  return page.getByRole("region", { name: scene }).getByRole("slider", { name: "Execution tier" });
}

// One block, one worker: the page is built once, not once per parallel worker.
test.describe.configure({ mode: "serial" });
test.beforeAll(buildPlayground);

for (const variant of ["light", "dark", "narrow"] as const) {
  test(`P2.6 execution tier slider, ${variant}`, async ({ page }) => {
    if (variant === "narrow") await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/p2-6-slider.html");
    if (variant === "dark") {
      await page.locator("html").evaluate((element) => element.classList.add("dark"));
    }
    await expect(sliderIn(page, "Three levels")).toHaveAttribute("aria-valuetext", "Medium");
    await expect(sliderIn(page, "Six levels")).toHaveAttribute("aria-valuetext", "High");
    const unsupported = sliderIn(page, "A level the model does not offer");
    await expect(unsupported).toBeDisabled();
    await expect(unsupported).toHaveAttribute("aria-valuetext", "Unavailable");
    await expect(page.getByText("This model does not offer that level.")).toBeVisible();
    await expect(page.getByText("Could not save the tier.")).toBeVisible();
    await page.screenshot({
      path: `../../.data/screenshots/p2-6-slider-${variant}.png`,
      fullPage: true,
    });
  });
}

test("P2.6 execution tier slider steps with the arrow keys", async ({ page }) => {
  await page.goto("/p2-6-slider.html");
  const three = sliderIn(page, "Three levels");
  await three.focus();
  await three.press("ArrowRight");
  await expect(three).toHaveAttribute("aria-valuetext", "High");
  await three.press("ArrowLeft");
  await three.press("ArrowLeft");
  await expect(three).toHaveAttribute("aria-valuetext", "Low");
  await expect(sliderIn(page, "Six levels")).toHaveAttribute("aria-valuetext", "High");
});
