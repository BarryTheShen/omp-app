/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PAGE_NAME = "p7-5-context-settings-playground";
const PLAYGROUND_PATH = `/${PAGE_NAME}.html`;

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P7/settings/playground-entry.tsx",
      "--outfile",
      `dist/${PAGE_NAME}.js`,
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The web build did not emit a stylesheet for context settings.");
  mkdirSync(screenshots, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, `${PAGE_NAME}.html`),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="stylesheet" href="/assets/${css}" />
    <script>
      if (window.localStorage.getItem("omp-app.theme") === "dark") document.documentElement.classList.add("dark");
    </script>
    <title>Context settings</title>
  </head>
  <body>
    <div id="p7-context-settings-playground-root"></div>
    <script type="module" src="/${PAGE_NAME}.js"></script>
  </body>
</html>
`,
  );
}

async function expectBackgroundToken(page: Page): Promise<void> {
  const colors = await page.locator("[data-p7-context-settings]").evaluate((root) => {
    const tokenProbe = document.createElement("span");
    tokenProbe.className = "bg-background text-foreground";
    document.body.append(tokenProbe);
    const result = {
      background: getComputedStyle(root).backgroundColor,
      backgroundToken: getComputedStyle(tokenProbe).backgroundColor,
      color: getComputedStyle(root).color,
      colorToken: getComputedStyle(tokenProbe).color,
    };
    tokenProbe.remove();
    return result;
  });
  expect(colors.background).toBe(colors.backgroundToken);
  expect(colors.color).toBe(colors.colorToken);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
}

function playgroundUrl(currentUrl: string, folder: string): string {
  const url = new URL(currentUrl);
  url.pathname = PLAYGROUND_PATH;
  url.searchParams.set("layer", "project");
  url.searchParams.set("folder", folder);
  return url.toString();
}

/** Opens one section from the chips, as the person does. */
async function openSection(scope: Page | Locator, title: string): Promise<void> {
  await scope.getByRole("tab", { name: title, exact: true }).click();
}

/** Writes the project's config file, the way another writer (omp in a terminal, an editor) would. */
function writeProjectConfig(path: string, yaml: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml);
}

realTest.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

realTest(
  "reads and saves context settings through a real omp-backed ConfigStore",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(playgroundUrl(page.url(), realApp.folder));

    const root = page.locator("[data-p7-context-settings]");
    await expect(root).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Context" })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(4);
    await expect(page.locator("[data-p7-context-section]")).toHaveCount(1);
    await expectBackgroundToken(page);

    await openSection(page, "Compaction");
    const compaction = page.locator('[data-p7-context-section="P7.contextCompaction"]');
    const switches = compaction.locator('input[type="checkbox"]');
    const compactionThreshold = compaction.getByRole("combobox").first();
    const autoCompactSource = page.getByTestId("compaction.enabled-provenance");
    await expect(autoCompactSource).toContainText("omp's default");
    await expect(switches.first()).toBeChecked();
    await expect(compactionThreshold).toHaveValue("-1");

    await switches.first().uncheck();
    await compactionThreshold.selectOption("50");
    await compaction.getByRole("button", { name: "Save changes" }).click();
    await expect(compaction.getByText("Applied")).toBeVisible();
    await expect(autoCompactSource).toContainText("Saved for this project");
    await expect(switches.first()).not.toBeChecked();
    await expect(compactionThreshold).toHaveValue("50");

    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "p7-5-context-settings-light.png"),
      fullPage: true,
    });
    await page.reload();
    await openSection(page, "Compaction");
    const reloadedCompaction = page.locator('[data-p7-context-section="P7.contextCompaction"]');
    await expect(reloadedCompaction.locator('input[type="checkbox"]').first()).not.toBeChecked();
    await expect(reloadedCompaction.getByRole("combobox").first()).toHaveValue("50");
    await expect(page.getByTestId("compaction.enabled-provenance")).toContainText(
      "Saved for this project",
    );

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => {
          window.localStorage.setItem("omp-app.theme", "dark");
        }),
    });
    await dark.goto(playgroundUrl(dark.url(), realApp.folder));
    await expect(dark.locator("html")).toHaveClass(/dark/);
    await expect(dark.locator("[data-p7-context-settings]")).toBeVisible({ timeout: 30_000 });
    await expectBackgroundToken(dark);
    await openSection(dark, "Compaction");
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "p7-5-context-settings-dark.png"),
      fullPage: true,
    });

    await dark.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(dark);
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "p7-5-context-settings-narrow.png"),
      fullPage: true,
    });

    await dark.locator("html").evaluate((element) => {
      if (element instanceof HTMLElement) element.style.zoom = "200%";
    });
    await expectNoHorizontalOverflow(dark);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "two sections staged, then saved one after the other, both kept with no false conflict",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(playgroundUrl(page.url(), realApp.folder));
    await expect(page.getByRole("tab")).toHaveCount(4, { timeout: 30_000 });

    const general = page.locator('[data-p7-context-section="P7.contextGeneral"]');
    await general.getByRole("checkbox", { name: "Extended Context" }).check();
    await openSection(page, "Compaction");
    const compaction = page.locator('[data-p7-context-section="P7.contextCompaction"]');
    await compaction.getByRole("checkbox", { name: "Auto-Compact" }).uncheck();

    await openSection(page, "General");
    await general.getByRole("button", { name: "Save changes" }).click();
    await expect(general.getByText("Applied")).toBeVisible();

    await openSection(page, "Compaction");
    await compaction.getByRole("button", { name: "Save changes" }).click();
    await expect(compaction.getByText("Applied")).toBeVisible();
    await expect(page.locator("[data-p7-context-section] [role='alert']")).toHaveCount(0);

    const projectConfig = join(realApp.folder, ".omp", "config.yml");
    await expect.poll(() => readFileSync(projectConfig, "utf8")).toContain("extendedContext: true");
    await expect.poll(() => readFileSync(projectConfig, "utf8")).toContain("enabled: false");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a change another writer made to a staged setting is a conflict, and the edit is not overwritten",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(playgroundUrl(page.url(), realApp.folder));
    await expect(page.getByRole("tab")).toHaveCount(4, { timeout: 30_000 });

    await openSection(page, "Compaction");
    const compaction = page.locator('[data-p7-context-section="P7.contextCompaction"]');
    const sectionAlerts = page.locator("[data-p7-context-section] [role='alert']");
    const threshold = compaction.getByRole("combobox", {
      name: "Compaction Threshold",
      exact: true,
    });
    const save = compaction.getByRole("button", { name: "Save changes" });
    const projectConfig = join(realApp.folder, ".omp", "config.yml");

    await threshold.selectOption("70");
    writeProjectConfig(projectConfig, "compaction:\n  thresholdPercent: 80\n");

    // The change reaches the section at once through the change stream, or only when the person saves.
    const conflict = compaction.getByRole("alert");
    await expect
      .poll(async () => (await conflict.count()) > 0 || (await save.isEnabled()))
      .toBe(true);
    if (await save.isEnabled()) await save.click();
    await expect(conflict).toContainText("Settings changed elsewhere", { timeout: 15_000 });
    await expect(save).toBeDisabled();
    await expect(threshold).toBeDisabled();
    expect(readFileSync(projectConfig, "utf8")).toContain("thresholdPercent: 80");

    await conflict.getByRole("button", { name: "Keep my edits" }).click();
    await save.click();
    await expect.poll(() => readFileSync(projectConfig, "utf8")).toContain("thresholdPercent: 70");
    await expect(sectionAlerts).toHaveCount(0);

    // Embedded, the view draws no page background or padding of its own, as on the live Settings screen.
    const embedded = await realApp.open();
    await embedded.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    const embeddedUrl = new URL(playgroundUrl(embedded.url(), realApp.folder));
    embeddedUrl.searchParams.set("embedded", "1");
    await embedded.goto(embeddedUrl.toString());
    const root = embedded.locator("[data-p7-context-settings]");
    await expect(root).toBeVisible({ timeout: 30_000 });
    const chrome = await root.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, padding: style.paddingTop };
    });
    expect(chrome).toEqual({ background: "rgba(0, 0, 0, 0)", padding: "0px" });
    await expect(embedded.getByRole("heading", { name: "Context" })).toHaveCount(0);
    await waitForFiniteAnimations(embedded);
    await embedded.screenshot({
      path: join(screenshots, "p7-5-context-settings-embedded.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

async function openContextTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Context", exact: true }).click();
}

realTest(
  "the Context tab in Settings keeps a staged edit across a tab switch, saves it, and keeps it after a reload",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await openContextTab(page);

    const settings = page.getByTestId("settings-screen");
    await expect(settings.getByRole("tab")).toHaveCount(4);
    await openSection(settings, "Compaction");
    const compaction = settings.locator('[data-p7-context-section="P7.contextCompaction"]');
    await compaction.getByRole("checkbox", { name: "Auto-Compact" }).uncheck();

    // Another tab, then back: the staged edit is still there, and Save and the scope buttons are locked.
    await settings.getByRole("button", { name: "Files", exact: true }).click();
    await expect(
      settings.getByRole("button", { name: "This workspace", exact: true }),
    ).toBeDisabled();
    await expect(
      settings.getByRole("button", { name: "All workspaces", exact: true }),
    ).toBeDisabled();
    await settings.getByRole("button", { name: "Context", exact: true }).click();
    await expect(compaction.getByRole("checkbox", { name: "Auto-Compact" })).not.toBeChecked();

    await compaction.getByRole("button", { name: "Save changes" }).click();
    await expect(compaction.getByText("Applied")).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "This workspace", exact: true }),
    ).toBeEnabled();

    await page.reload();
    await openContextTab(page);
    await openSection(page.getByTestId("settings-screen"), "Compaction");
    await expect(
      page
        .getByTestId("settings-screen")
        .locator('[data-p7-context-section="P7.contextCompaction"]')
        .getByRole("checkbox", { name: "Auto-Compact" }),
    ).not.toBeChecked();

    await waitForFiniteAnimations(page);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.screenshot({
      path: join(screenshots, "p7-5-settings-context-light.png"),
      fullPage: true,
    });

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => {
          window.localStorage.setItem("omp-app.theme", "dark");
        }),
    });
    await dark.setViewportSize({ width: 1280, height: 1000 });
    await openContextTab(dark);
    await expect(dark.locator("html")).toHaveClass(/dark/);
    await openSection(dark.getByTestId("settings-screen"), "Compaction");
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "p7-5-settings-context-dark.png"),
      fullPage: true,
    });

    await dark.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(dark);
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "p7-5-settings-context-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
