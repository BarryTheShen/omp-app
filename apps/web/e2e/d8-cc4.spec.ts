/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");

const SURFACES = [
  ["goal", "src/modules/D8/goal/playground.tsx", "d8-cc4-goal.js", "goal-playground-root", "Goal"],
  [
    "guided",
    "src/modules/D8/guided/playground.tsx",
    "d8-cc4-guided.js",
    "d8-4-guided-playground-root",
    "Guided goal",
  ],
  [
    "loop",
    "src/modules/D8/loop/playground.tsx",
    "d8-cc4-loop-playground.js",
    "loop-playground-root",
    "Loop",
  ],
  [
    "workers",
    "src/modules/D8/workers/playground.tsx",
    "d8-cc4-workers.js",
    "workers-playground-root",
    "Workers",
  ],
] as const;

function buildPlaygrounds(): void {
  for (const [, source, outfile] of SURFACES) {
    execFileSync("bun", ["build", source, "--outfile", `dist/${outfile}`, "--target=browser"], {
      cwd: APP_ROOT,
      stdio: "inherit",
    });
  }
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for D8 CC4.");
  for (const [name, , outfile, root, title] of SURFACES) {
    for (const dark of [false, true]) {
      const themeClass = dark ? ' class="dark"' : "";
      writeFileSync(
        join(DIST_ROOT, `d8-cc4-${name}${dark ? "-dark" : ""}.html`),
        `<!doctype html>
<html lang="en"${themeClass}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <title>${title} CC4 playground</title>
  </head>
  <body>
    <div id="${root}"></div>
    <script type="module" src="/${outfile}"></script>
  </body>
</html>
`,
      );
    }
  }
}

async function expectStyles(page: Page, root: string): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  await expect(
    page.getByTestId(
      root === "loop-playground-root" ? "loop-playground" : root.replace("-root", ""),
    ),
  ).toBeVisible();
  const hasTokenBackground = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bg-background";
    document.body.append(probe);
    const background = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return background !== "rgba(0, 0, 0, 0)";
  });
  expect(hasTokenBackground).toBe(true);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

async function expectReducedMotion(page: Page, root: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches))
    .toBe(true);
  const testId = root === "loop-playground-root" ? "loop-playground" : root.replace("-root", "");
  const button = page.getByTestId(testId).locator('[data-slot="button"]').first();
  await expect
    .poll(() =>
      button.evaluate((element) => {
        const duration = getComputedStyle(element).transitionDuration;
        const value = Number.parseFloat(duration);
        return duration.endsWith("ms") ? value : value * 1000;
      }),
    )
    .toBeLessThanOrEqual(0.01);
}
async function assertFocusStaysIn(page: Page, selector: string): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate((target) => {
      const active = document.activeElement;
      const container = document.querySelector(target);
      return (
        active instanceof HTMLElement &&
        container instanceof HTMLElement &&
        container.contains(active)
      );
    }, selector);
    expect(inside).toBe(true);
  }
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygrounds));

test("D8 surfaces work with keyboard only and guided focus is trapped and restored", async ({
  page,
}) => {
  await page.goto("/d8-cc4-guided.html");
  await expectStyles(page, "d8-4-guided-playground-root");
  const start = page.getByRole("button", { name: "Start guided goal", exact: true });
  await start.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await assertFocusStaysIn(page, '[role="dialog"]');
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start again", exact: true })).toBeFocused();

  await page.goto("/d8-cc4-loop.html");
  await expectStyles(page, "loop-playground-root");
  const count = page.getByRole("textbox").first();
  await count.focus();
  await page.keyboard.type("2");
  await page.getByRole("button", { name: "Start loop", exact: true }).focus();
  await page.keyboard.press("Enter");
  const pause = page.getByRole("button", { name: "Pause loop", exact: true });
  await expect(pause).toBeFocused();

  await page.goto("/d8-cc4-goal.html?closed=1");
  await expectStyles(page, "goal-playground-root");
  const openGoal = page.getByRole("button", { name: "Open goal panel", exact: true });
  await openGoal.focus();
  await page.keyboard.press("Enter");
  const goal = page.getByRole("region", { name: "Goal" });
  await expect(goal).toHaveAttribute("data-panel-open", "true");
  const closeGoal = goal.getByRole("button", { name: "Close Goal", exact: true });
  await closeGoal.focus();
  await page.keyboard.press("Enter");
  await expect(openGoal).toBeFocused();

  await page.goto("/d8-cc4-workers.html?closed=1");
  await expectStyles(page, "workers-playground-root");
  const openWorkers = page.getByRole("button", { name: "Open workers panel", exact: true });
  await openWorkers.focus();
  await page.keyboard.press("Enter");
  const workers = page.getByRole("region", { name: "Workers", exact: true });
  await expect(workers).toHaveAttribute("data-panel-open", "true");
  const closeWorkers = workers.getByRole("button", { name: "Close Workers", exact: true });
  await closeWorkers.focus();
  await page.keyboard.press("Enter");
  await expect(openWorkers).toBeFocused();
});

test("D8 surfaces honor reduced motion and 200% zoom without overflow", async ({ browser }) => {
  for (const [name, , , root] of SURFACES) {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 390, height: 844 },
    });
    await page.goto(`/d8-cc4-${name}.html`);
    await expectStyles(page, root);
    await expectReducedMotion(page, root);
    await page.locator("html").evaluate((element) => {
      (element as HTMLElement).style.zoom = "200%";
    });
    await expectNoHorizontalOverflow(page);
    await page.close();
  }
});

test("D8 surfaces provide light, dark and narrow screenshots", async ({ browser }) => {
  test.setTimeout(120_000);
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  for (const [name, , , root, title] of SURFACES) {
    const light = await browser.newPage({ viewport: { width: 1280, height: 844 } });
    await light.goto(`/d8-cc4-${name}.html`);
    await expectStyles(light, root);
    await expect(light.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await light.screenshot({
      path: join(SCREENSHOT_ROOT, `d8-cc4-${name}-light.png`),
      fullPage: true,
    });
    await light.close();

    const dark = await browser.newPage({ viewport: { width: 1280, height: 844 } });
    await dark.goto(`/d8-cc4-${name}-dark.html`);
    await expectStyles(dark, root);
    await expect(dark.locator("html")).toHaveClass(/dark/);
    await dark.screenshot({
      path: join(SCREENSHOT_ROOT, `d8-cc4-${name}-dark.png`),
      fullPage: true,
    });
    await dark.close();

    const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await narrow.goto(`/d8-cc4-${name}.html`);
    await expectStyles(narrow, root);
    await expectNoHorizontalOverflow(narrow);
    await narrow.screenshot({
      path: join(SCREENSHOT_ROOT, `d8-cc4-${name}-narrow.png`),
      fullPage: true,
    });
    await narrow.close();
  }
  for (const state of [
    { key: "interviewing", file: "busy-interviewing", label: "Interview in progress" },
    { key: "creating", file: "busy-creating", label: "Creating goal…" },
    { key: "blocked", file: "blocked", label: "Start guided goal" },
  ] as const) {
    const captures = [
      { theme: "light", suffix: "", width: 1280 },
      { theme: "dark", suffix: "-dark", width: 1280 },
      { theme: "narrow", suffix: "", width: 390 },
    ] as const;
    for (const capture of captures) {
      const page = await browser.newPage({
        viewport: { width: capture.width, height: 844 },
      });
      await page.goto(`/d8-cc4-guided${capture.suffix}.html?state=${state.key}`);
      await expectStyles(page, "d8-4-guided-playground-root");
      const start = page.getByRole("button", { name: state.label, exact: true });
      await expect(start).toHaveAttribute("aria-disabled", "true");
      await expect(start).toHaveCSS("opacity", "0.5");
      const baseline = await start.evaluate((button) => {
        const style = getComputedStyle(button);
        return { background: style.backgroundColor, transform: style.transform };
      });
      const box = await start.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await expect
        .poll(() =>
          start.evaluate((button) => {
            const style = getComputedStyle(button);
            return { background: style.backgroundColor, transform: style.transform };
          }),
        )
        .toEqual(baseline);
      if (capture.width === 390) await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: join(SCREENSHOT_ROOT, `d8-cc4-guided-${state.file}-${capture.theme}.png`),
        fullPage: true,
      });
      await page.close();
    }
  }
});
