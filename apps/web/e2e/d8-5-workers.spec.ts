/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, test, expect as visualExpect } from "@playwright/test";
import { expect as realExpect, realTest } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");

declare global {
  interface Window {
    mountRealWorkersPanel?: (folder: string) => Promise<void>;
    unmountRealWorkersPanel?: () => void;
    sendRealWorkersPrompt?: (message: string) => Promise<void>;
  }
}

function buildWorkersPlaygrounds(): void {
  for (const [source, outfile] of [
    ["src/modules/D8/workers/playground.tsx", "d8-5-workers-playground.js"],
    ["src/modules/D8/workers/real-playground.tsx", "d8-5-workers-real-playground.js"],
  ] as const) {
    execFileSync("bun", ["build", source, "--outfile", `dist/${outfile}`, "--target=browser"], {
      cwd: APP_ROOT,
      stdio: "inherit",
    });
  }
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css)
    throw new Error("The production build did not emit a stylesheet for the workers panel.");
  const writePage = (fileName: string, dark: boolean) => {
    const themeClass = dark ? ' class="dark"' : "";
    writeFileSync(
      join(DIST_ROOT, fileName),
      `<!doctype html>
<html lang="en"${themeClass}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Workers panel playground</title>
  </head>
  <body>
    <div id="workers-playground-root"></div>
    <script type="module" src="/d8-5-workers-playground.js"></script>
  </body>
</html>
`,
    );
  };
  writePage("d8-5-workers-playground.html", false);
  writePage("d8-5-workers-dark-playground.html", true);
}

async function expectTokenBackground(page: Page): Promise<void> {
  const usesSidebarToken = await page.getByTestId("workers-playground").evaluate((root) => {
    const panel = root.querySelector<HTMLElement>("section[data-panel-lifecycle]");
    if (!panel) return false;
    const background = getComputedStyle(panel).backgroundColor;
    const sidebar = getComputedStyle(document.documentElement).getPropertyValue("--sidebar").trim();
    const probe = document.createElement("div");
    probe.className = "bg-sidebar";
    document.body.append(probe);
    const tokenBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return (
      sidebar.length > 0 && tokenBackground !== "rgba(0, 0, 0, 0)" && background === tokenBackground
    );
  });
  visualExpect(usesSidebarToken).toBe(true);
}

test.beforeAll(() => {
  buildWorkersPlaygrounds();
});

test("workers panel lists its tan, vibe and subagent sections, and keeps stop gated, in light, dark and narrow layouts", async ({
  page,
}) => {
  await page.goto("/d8-5-workers-playground.html");
  const panel = page.getByRole("region", { name: "Workers", exact: true });
  await visualExpect(panel).toBeVisible();
  await visualExpect(panel).toContainText("Review the failing login tests");
  await visualExpect(panel).toContainText("Running");
  await visualExpect(panel).toContainText("Using bash · 7 tool calls");
  await visualExpect(panel).toContainText("Finished");
  await visualExpect(panel).toContainText("Cancelled");
  await visualExpect(panel).toContainText("Tan workers");
  await visualExpect(panel).toContainText("Vibe workers");
  await visualExpect(panel).toContainText("Subagents");
  await visualExpect(panel).toContainText("Queued");
  await visualExpect(panel.getByRole("button", { name: /^Stop / })).toHaveCount(1);
  await visualExpect(panel.getByRole("button", { name: /^Start / })).toHaveCount(0);
  await expectTokenBackground(page);
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOT_ROOT, "d8-5-workers-light.png"), fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.goto("/d8-5-workers-dark-playground.html");
  await visualExpect(darkPage.locator("html")).toHaveClass(/dark/);
  await expectTokenBackground(darkPage);
  await darkPage.screenshot({
    path: join(SCREENSHOT_ROOT, "d8-5-workers-dark.png"),
    fullPage: true,
  });
  await darkPage.close();

  const narrowPage = await page.context().newPage();
  await narrowPage.setViewportSize({ width: 390, height: 844 });
  await narrowPage.goto("/d8-5-workers-playground.html");
  await visualExpect(
    narrowPage.getByRole("region", { name: "Workers", exact: true }),
  ).toHaveAttribute("data-panel-layout", "drawer");
  // At 390 px the rows wrap instead of widening the page: nothing scrolls sideways.
  const widthOverflow = await narrowPage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  visualExpect(widthOverflow).toBeLessThanOrEqual(0);
  await expectTokenBackground(narrowPage);
  await narrowPage.screenshot({
    path: join(SCREENSHOT_ROOT, "d8-5-workers-narrow.png"),
    fullPage: true,
  });
  await narrowPage.close();
});

realTest(
  "workers panel shows a real omp worker as running, and stops it through omp",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.addScriptTag({ url: "/d8-5-workers-real-playground.js" });
    try {
      await page.evaluate(async (folder) => {
        if (!window.mountRealWorkersPanel)
          throw new Error("The real workers panel test hook is missing.");
        await window.mountRealWorkersPanel(folder);
      }, realApp.folder);
      const panel = page.getByRole("region", { name: "Workers", exact: true });
      await realExpect(panel).toBeVisible({ timeout: 60_000 });
      await realExpect(panel.getByRole("button", { name: /^Start / })).toHaveCount(0);

      await page.evaluate(async () => {
        if (!window.sendRealWorkersPrompt) throw new Error("The real prompt hook is missing.");
        await window.sendRealWorkersPrompt("spawn_steerable_subagent");
      });
      await realExpect(panel).toContainText("Running", { timeout: 90_000 });

      const stop = panel.getByRole("button", { name: /^Stop / });
      await realExpect(stop).toBeEnabled({ timeout: 30_000 });
      await stop.click();
      await realExpect(panel).toContainText("Cancelled", { timeout: 60_000 });
      await realExpect(realApp.ompProcesses().length).toBeGreaterThan(0);
    } finally {
      await page.evaluate(() => window.unmountRealWorkersPanel?.());
    }
  },
);
