/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PLAYGROUND = "/error-boundary-playground.html";
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/app/error-boundary-playground.tsx",
      "--outfile",
      "dist/error-boundary-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "error-boundary-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>omp error boundary playground</title>
  </head>
  <body>
    <div id="error-boundary-playground-root"></div>
    <script type="module" src="/error-boundary-playground.js"></script>
  </body>
</html>
`,
  );
}

test.beforeAll(buildPlaygroundPage);

for (const [name, dark, width, height] of [
  ["light", false, 1280, 720],
  ["dark", true, 1280, 720],
  ["phone", false, 390, 844],
] as const) {
  test(`a page failure shows a plain message with Reload and Copy details (${name})`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    // The failure is on purpose: React and the boundary report it (the error, its component
    // stack and the boundary's own line); any other console error is a real problem.
    const unexpected: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      const expected =
        text.includes("usage.percent") ||
        text.includes("<Broken>") ||
        text.includes("the page failed while rendering");
      if (!expected) unexpected.push(text);
    });
    await page.setViewportSize({ width, height });
    await page.goto(`${PLAYGROUND}#token=never-copied-token`);
    if (dark) await page.evaluate(() => document.documentElement.classList.add("dark"));
    // Dark is a dark colour and light a light one: the screen follows the theme like the app does
    // (the theme colours are oklch(), so read the real pixel through a canvas).
    const brightness = await page.locator('[data-app-error="true"]').evaluate((element) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no canvas");
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
      return (red + green + blue) / 3;
    });
    expect(brightness < 128).toBe(dark);

    const alert = page.locator('[data-app-error="true"]').getByRole("alert");
    await expect(alert).toContainText("Something went wrong in the page");
    await expect(page.getByText(/Your chats are kept by omp/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();

    await page.getByRole("button", { name: "Copy details" }).click();
    await expect(page.getByText(/Copied\./)).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("usage.percent: Too big");
    expect(clipboard).not.toContain("never-copied-token");

    await page.getByText("Technical details").click();
    await expect(page.getByText(/Component stack/)).toBeVisible();
    // Nothing runs off the side of a phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({
      path: join(SCREENSHOT_ROOT, `error-boundary-${name}.png`),
      fullPage: true,
    });
    expect(unexpected).toEqual([]);
  });
}

test("Reload loads the page again", async ({ page }) => {
  await page.goto(PLAYGROUND);
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  const navigated = page.waitForEvent("load");
  await page.getByRole("button", { name: "Reload" }).click();
  await navigated;
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});
