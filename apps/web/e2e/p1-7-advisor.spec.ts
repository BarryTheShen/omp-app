/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, expect, type Page } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const WEB_ROOT = process.cwd();
const DIST_ROOT = join(WEB_ROOT, "dist");
const PAGE_NAME = "p1-7-advisor-live";
const PAGE_ROOT = join(DIST_ROOT, PAGE_NAME);

function buildAdvisorPage(): void {
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for the advisor.");
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P1/advisor/live-playground.tsx",
      "--outdir",
      PAGE_ROOT,
      "--target=browser",
    ],
    {
      cwd: WEB_ROOT,
      stdio: "inherit",
    },
  );
  writeFileSync(
    join(DIST_ROOT, `${PAGE_NAME}.html`),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/${PAGE_NAME}/live-playground.js"></script>
  </head>
  <body><div id="p1-7-advisor-live-root"></div></body>
</html>
`,
  );
}

async function openAdvisor(
  browser: Browser,
  origin: string,
  token: string,
  thread: string,
): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(
    `${origin}/${PAGE_NAME}.html?thread=${encodeURIComponent(thread)}#token=${encodeURIComponent(token)}`,
  );
  await expect(page.getByTestId("p1-advisor-live")).toBeVisible({ timeout: 80_000 });
  return page;
}

async function expectTokenBackground(page: Page): Promise<void> {
  const colors = await page.locator("main").evaluate((main) => {
    const canvas = document.createElement("canvas").getContext("2d");
    if (!canvas) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      canvas.fillStyle = "#000";
      canvas.fillStyle = color;
      return canvas.fillStyle;
    };
    return {
      background: normalize(getComputedStyle(main).backgroundColor),
      token: normalize(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ),
    };
  });
  expect(colors.background).toBe(colors.token);
}

realTest.beforeAll(() =>
  ensurePlaygroundBuilt(() => {
    buildAdvisorPage();
  }),
);

realTest(
  "real omp: advisor settings save and reload, and the live surface works in light, dark, and narrow views",
  async ({ realApp, browser }) => {
    const app = await realApp.open();
    await startChat(app);
    const thread = await app.evaluate(() => window.localStorage.getItem("omp.app.root.thread"));
    if (!thread) throw new Error("The open chat did not expose a thread id.");
    const page = await openAdvisor(browser, new URL(app.url()).origin, realApp.token, thread);
    await expect(page.getByRole("heading", { name: "Advisor settings" })).toBeVisible();
    const enabled = page.getByRole("checkbox", { name: "Enable Advisor" });
    await enabled.check();
    const saveEnable = page.getByRole("button", { name: "Save Enable Advisor" });
    await saveEnable.click();
    await expect(enabled).toBeChecked();
    await expect(saveEnable).toBeEnabled();

    await mkdir(screenshots, { recursive: true });
    await expectTokenBackground(page);
    await page.screenshot({ path: join(screenshots, "p1-7-advisor-light.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await expectTokenBackground(page);
    await page.screenshot({ path: join(screenshots, "p1-7-advisor-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await expectTokenBackground(page);
    await page.screenshot({ path: join(screenshots, "p1-7-advisor-390.png"), fullPage: true });

    await page.reload();
    const reloadedEnabled = page.getByRole("checkbox", { name: "Enable Advisor" });
    await expect(reloadedEnabled).toBeChecked();
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.locator('[data-advisor-command-state="completed"]')).toBeVisible({
      timeout: 30_000,
    });
    writeFileSync(join(realApp.agentDir, "config.yml"), "advisor:\n  enabled: false\n");
    await reloadedEnabled.uncheck();
    await page.getByRole("button", { name: "Save Enable Advisor" }).click();
    await expect(
      page.getByRole("heading", { name: "These settings changed elsewhere" }),
    ).toBeVisible();
    await expect(reloadedEnabled).not.toBeChecked();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectTokenBackground(page);
    await page.screenshot({
      path: join(screenshots, "p1-7-advisor-conflict-light.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await expectTokenBackground(page);
    await page.screenshot({
      path: join(screenshots, "p1-7-advisor-conflict-390.png"),
      fullPage: true,
    });

    await page.getByRole("button", { name: "Reload settings" }).click();
    await expect(
      page.getByRole("heading", { name: "These settings changed elsewhere" }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("spinbutton", { name: "Advisor Review Interval" }).fill("0");
    await page.getByRole("button", { name: "Save Advisor Review Interval" }).click();
    await expect(page.getByText("Advisor setting was not saved", { exact: true })).toBeVisible();
    await expectTokenBackground(page);
    await page.screenshot({
      path: join(screenshots, "p1-7-advisor-unsaved-light.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await expectTokenBackground(page);
    await page.screenshot({
      path: join(screenshots, "p1-7-advisor-unsaved-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
