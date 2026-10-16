/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { realTest, screenshots, sendPrompt, startChat, waitForFiniteAnimations } from "./real-omp";

const WEB_ROOT = process.cwd();
const DIST_ROOT = join(WEB_ROOT, "dist");

function buildPlayground(): void {
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for the debug picker.");
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D6/debug/playground.tsx",
      "--outdir",
      "dist/d6-4-debug",
      "--target=browser",
    ],
    { cwd: WEB_ROOT, stdio: "inherit" },
  );
  writeFileSync(
    join(DIST_ROOT, "d6-4-debug.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/d6-4-debug/playground.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
  );
}

async function expectTokenBackground(page: Page): Promise<void> {
  const colors = await page.locator("main").evaluate((main) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      context.fillStyle = "#000000";
      context.fillStyle = color;
      return context.fillStyle;
    };
    const background = getComputedStyle(main).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return { background: normalize(background), token: normalize(token), rawToken: token };
  });
  expect(colors.rawToken).not.toBe("");
  expect(colors.background).toBe(colors.token);
}

realTest(
  "real omp starts before the local debug showcase, where unavailable diagnostics are focus-safe",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    buildPlayground();
    mkdirSync(screenshots, { recursive: true });
    const app = await realApp.open();
    const composer = await startChat(app);
    await sendPrompt(composer, "pong");
    await expect(app.getByText("pong").first()).toBeVisible({ timeout: 60_000 });

    const browser = app.context().browser();
    if (browser === null) throw new Error("The browser is unavailable for the debug picker.");
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    const origin = new URL(app.url()).origin;
    await page.goto(`${origin}/d6-4-debug.html#token=${encodeURIComponent(realApp.token)}`);
    const launch = page.getByRole("button", { name: "Open debug tools" });
    await expect(
      page.getByText("This local showcase keeps terminal-only diagnostics unavailable."),
    ).toBeVisible();
    await expect(launch).toBeVisible();
    await expectTokenBackground(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "d6.4-debug-light.png"), fullPage: true });

    await launch.click();
    await expect(page.getByTestId("dialog-frame")).toBeVisible();
    const recentLogs = page.getByRole("option", { name: /Recent logs/ });
    await expect(recentLogs).toBeVisible();
    await expectTokenBackground(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d6.4-debug-selector-light.png"),
      fullPage: true,
    });
    await recentLogs.click();
    const reason = page.getByRole("status");
    await expect(reason).toHaveText(
      "This diagnostic is available in omp's terminal, not in the app.",
    );
    await expect(page.getByRole("button", { name: "Dismiss notice" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null))
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(launch).toBeFocused();
    await page.addInitScript(() => {
      if (document.documentElement) document.documentElement.classList.add("dark");
      else
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            document.documentElement.classList.add("dark");
          },
          { once: true },
        );
    });
    await page.reload();
    await expectTokenBackground(page);
    await launch.click();
    await expect(page.getByTestId("dialog-frame")).toBeVisible();
    await expectTokenBackground(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "d6.4-debug-dark.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(launch).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await launch.click();
    await expect(page.getByTestId("dialog-frame")).toBeVisible();
    await expectTokenBackground(page);
    await page.getByRole("option", { name: /Recent logs/ }).click();
    await expect(page.getByRole("status")).toHaveText(
      "This diagnostic is available in omp's terminal, not in the app.",
    );
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "d6.4-debug-narrow.png"), fullPage: true });
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    await context.close();
    expect(problems).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);
