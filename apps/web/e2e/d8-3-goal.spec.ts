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
    mountRealGoalPanel?: (folder: string) => Promise<void>;
    unmountRealGoalPanel?: () => void;
  }
}

function buildGoalPlaygrounds(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D8/goal/playground.tsx",
      "--outfile",
      "dist/d8-3-goal-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/D8/goal/real-playground.tsx",
      "--outfile",
      "dist/d8-3-goal-real-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for the goal panel.");
  const writeGoalPage = (fileName: string, dark: boolean) => {
    const themeClass = dark ? ' class="dark"' : "";
    writeFileSync(
      join(DIST_ROOT, fileName),
      `<!doctype html>
<html lang="en"${themeClass}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>Goal panel playground</title>
  </head>
  <body>
    <div id="goal-playground-root"></div>
    <script type="module" src="/d8-3-goal-playground.js"></script>
  </body>
</html>
`,
    );
  };
  writeGoalPage("d8-3-goal-playground.html", false);
  writeGoalPage("d8-3-goal-dark-playground.html", true);
}

async function expectTokenBackground(page: Page): Promise<void> {
  const usesSidebarToken = await page.getByTestId("goal-playground").evaluate((root) => {
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
  buildGoalPlaygrounds();
});

test("goal panel shows its objective, status and budget in light, dark and narrow layouts", async ({
  page,
}) => {
  await page.goto("/d8-3-goal-playground.html");
  const panel = page.getByRole("region", { name: "Goal" });
  await visualExpect(panel).toBeVisible();
  await visualExpect(panel).toContainText("Keep the project healthy and ready to ship");
  await visualExpect(panel).toContainText("Active");
  await visualExpect(panel).toContainText("50,000 tokens");
  await expectTokenBackground(page);
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOT_ROOT, "d8-3-goal-light.png"), fullPage: true });

  const darkPage = await page.context().newPage();
  await darkPage.goto("/d8-3-goal-dark-playground.html");
  await visualExpect(darkPage.locator("html")).toHaveClass(/dark/);
  await expectTokenBackground(darkPage);
  await darkPage.screenshot({ path: join(SCREENSHOT_ROOT, "d8-3-goal-dark.png"), fullPage: true });
  await darkPage.close();

  const narrowPage = await page.context().newPage();
  await narrowPage.setViewportSize({ width: 390, height: 844 });
  await narrowPage.goto("/d8-3-goal-playground.html");
  await visualExpect(narrowPage.getByRole("region", { name: "Goal" })).toHaveAttribute(
    "data-panel-layout",
    "drawer",
  );
  await expectTokenBackground(narrowPage);
  await narrowPage.screenshot({
    path: join(SCREENSHOT_ROOT, "d8-3-goal-narrow.png"),
    fullPage: true,
  });
  await narrowPage.close();

  const zoomPage = await page.context().newPage();
  await zoomPage.setViewportSize({ width: 640, height: 450 });
  await zoomPage.goto("/d8-3-goal-playground.html");
  const zoomPanel = zoomPage.getByRole("region", { name: "Goal" });
  await visualExpect(zoomPanel).toHaveAttribute("data-panel-layout", "drawer");
  const horizontalOverflow = await zoomPage.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  visualExpect(horizontalOverflow).toBe(false);
  await zoomPage.close();
});

realTest(
  "goal panel creates, pauses, resumes and drops a goal through a real omp session",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.addScriptTag({ url: "/d8-3-goal-real-playground.js" });
    try {
      await page.evaluate(async (folder) => {
        if (!window.mountRealGoalPanel)
          throw new Error("The real goal panel test hook is missing.");
        await window.mountRealGoalPanel(folder);
      }, realApp.folder);
      const panel = page.getByRole("region", { name: "Goal" });
      await realExpect(panel).toBeVisible({ timeout: 60_000 });
      await realExpect(panel).toContainText("No goal is active", { timeout: 60_000 });

      await panel.getByRole("button", { name: "Create a goal" }).click();
      const objectiveDialog = page.getByRole("dialog").last();
      await realExpect(objectiveDialog).toContainText("Set your goal");
      await objectiveDialog
        .getByRole("textbox", { name: "Set your goal" })
        .fill("Run a real goal lifecycle check");
      await objectiveDialog.getByRole("button", { name: "Save" }).click();

      const budgetDialog = page.getByRole("dialog").last();
      await realExpect(budgetDialog).toContainText("Set a token budget (optional)");
      await budgetDialog
        .getByRole("textbox", { name: "Set a token budget (optional)" })
        .fill("5000");
      await budgetDialog.getByRole("button", { name: "Continue" }).click();

      const reviewDialog = page.getByRole("dialog").last();
      await realExpect(reviewDialog).toContainText("Review your goal");
      await realExpect(reviewDialog).toContainText("Run a real goal lifecycle check");
      await realExpect(reviewDialog).toContainText("5,000 tokens");
      await reviewDialog.getByRole("button", { name: "Confirm" }).click();
      await realExpect(panel).toContainText("Active", { timeout: 60_000 });
      await realExpect(panel).toContainText("5,000 tokens");
      await realExpect(panel).toContainText(
        "omp will not continue this goal by itself. Add rpc to Goal Continuation Modes in Settings, Tasks, to let it.",
      );

      await panel.getByRole("button", { name: "Pause goal" }).click();
      await realExpect(panel).toContainText("Paused", { timeout: 30_000 });
      await panel.getByRole("button", { name: "Resume goal" }).click();
      await realExpect(panel).toContainText("Active", { timeout: 30_000 });
      await panel.getByRole("button", { name: "Drop goal" }).click();
      const dropDialog = page.getByRole("dialog").last();
      await realExpect(dropDialog).toContainText("Drop this goal?");
      await dropDialog.getByRole("button", { name: "Confirm" }).click();
      await realExpect(panel).toContainText("Dropped", { timeout: 30_000 });
      await realExpect(realApp.ompProcesses().length).toBeGreaterThan(0);
    } finally {
      await page.evaluate(() => window.unmountRealGoalPanel?.());
    }
  },
);
