/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");

type PlaygroundPage = {
  readonly source: string;
  readonly bundle: string;
  readonly html: string;
  readonly root: string;
  readonly title: string;
  readonly initialDark?: boolean;
  readonly themeQuery?: boolean;
};

const playgrounds: readonly PlaygroundPage[] = [
  {
    source: "src/components/blocks/playground.tsx",
    bundle: "ui-blocks-gallery.js",
    html: "ui-blocks-gallery.html",
    root: "ui-blocks-root",
    title: "UI building blocks",
  },
  {
    source: "src/modules/R1/ui/session-sidebar-playground.tsx",
    bundle: "ui-blocks-session-sidebar.js",
    html: "ui-blocks-session-sidebar.html",
    root: "r1-session-sidebar-playground-root",
    title: "R1 session sidebar",
  },
  {
    source: "src/modules/U5/panel/playground.tsx",
    bundle: "ui-blocks-panel-shell.js",
    html: "ui-blocks-panel-shell.html",
    root: "u5-panel-playground-root",
    title: "U5 panel shell",
    initialDark: true,
  },
  {
    source: "src/modules/S1/settings-kit/playground-entry.tsx",
    bundle: "ui-blocks-settings.js",
    html: "ui-blocks-settings.html",
    root: "settings-kit-playground-root",
    title: "S1 settings kit",
    themeQuery: true,
  },
];

function buildPlaygroundPages(): void {
  const css = readdirSync(join(DIST_ROOT, "assets")).find(
    (file) => file.startsWith("index-") && file.endsWith(".css"),
  );
  if (!css) throw new Error("The production build did not emit the app stylesheet.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });

  for (const playground of playgrounds) {
    execFileSync(
      "bun",
      ["build", playground.source, "--outfile", `dist/${playground.bundle}`, "--target=browser"],
      { cwd: APP_ROOT, stdio: "inherit" },
    );
    const themeClass = playground.initialDark ? ' class="dark"' : "";
    const themeScript = playground.themeQuery
      ? '<script>if (location.search.includes("theme=dark")) document.documentElement.classList.add("dark");</script>'
      : "";
    writeFileSync(
      join(DIST_ROOT, playground.html),
      `<!doctype html>
<html lang="en"${themeClass}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${themeScript}
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>${playground.title}</title>
  </head>
  <body>
    <div id="${playground.root}"></div>
    <script type="module" src="/${playground.bundle}"></script>
  </body>
</html>
`,
    );
  }
}

function trackConsoleErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

async function expectTokenBackground(locator: Locator, token: string): Promise<void> {
  const colors = await locator.evaluate((element, tokenName) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = `var(${tokenName})`;
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, expected };
  }, token);
  expect(colors.actual).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.actual).toBe(colors.expected);
}

async function waitForFiniteAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPages));
test.describe.configure({ mode: "serial" });

test("renders all shared blocks with token styles in light, dark, and narrow layouts", async ({
  page,
}) => {
  const assertNoConsoleErrors = trackConsoleErrors(page);
  await page.goto("/ui-blocks-gallery.html");
  const gallery = page.getByTestId("ui-blocks-playground");
  await expect(gallery).toBeVisible();
  await expect(page.getByRole("region", { name: "Session details" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Appearance" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Settings actions" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("No sessions in this folder");
  await expect(page.getByRole("alert")).toContainText("Unable to load the session list");
  await expectTokenBackground(gallery, "--background");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-components-light.png"),
    fullPage: true,
  });

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expectTokenBackground(gallery, "--background");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-components-dark.png"),
    fullPage: true,
  });

  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await expectTokenBackground(gallery, "--background");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-components-narrow.png"),
    fullPage: true,
  });
  assertNoConsoleErrors();
});

test("captures the migrated R1 list, empty state, and narrow drawer", async ({ page }) => {
  const assertNoConsoleErrors = trackConsoleErrors(page);
  const url = "/ui-blocks-session-sidebar.html";
  await page.goto(url);
  const sidebar = page.locator('[data-testid="r1-session-sidebar"]');
  await expect(sidebar.getByRole("option", { name: /Pinned project kickoff/ })).toBeVisible();
  await expectTokenBackground(
    page.locator('[data-testid="r1-session-sidebar"] aside[aria-label="Session list"]'),
    "--sidebar",
  );
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-r1-light.png"),
    fullPage: true,
  });

  await sidebar.getByRole("textbox", { name: "Search sessions" }).fill("no matching session");
  await expect(sidebar.getByText('No chats match "no matching session"')).toBeVisible();
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-r1-empty.png"),
    fullPage: true,
  });

  await sidebar.getByRole("textbox", { name: "Search sessions" }).fill("");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  const selectedRow = sidebar.getByRole("option", { name: /Pinned project kickoff/ });
  await selectedRow.hover();
  await sidebar.getByRole("button", { name: "More actions for Pinned project kickoff" }).click();
  await expect(
    sidebar.getByRole("menu", { name: "Actions for Pinned project kickoff" }),
  ).toBeVisible();
  await expectTokenBackground(
    page.locator('[data-testid="r1-session-sidebar"] aside[aria-label="Session list"]'),
    "--sidebar",
  );
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-r1-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.goto(url);
  await page.getByRole("button", { name: "Show sessions sidebar" }).click();
  await expect(page.locator('[data-shell-sidebar="left"]')).toBeVisible();
  await expect(sidebar.getByRole("option", { name: /Pinned project kickoff/ })).toBeVisible();
  await expectTokenBackground(
    page.locator('[data-testid="r1-session-sidebar"] aside[aria-label="Session list"]'),
    "--sidebar",
  );
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-r1-narrow.png"),
    fullPage: true,
  });
  assertNoConsoleErrors();
});

test("captures migrated U5 panel header, loading/error states, and narrow layout", async ({
  page,
}) => {
  const assertNoConsoleErrors = trackConsoleErrors(page);
  await page.goto("/ui-blocks-panel-shell.html");
  const panel = page.getByRole("region", { name: "Todo panel" });
  await expect(panel).toBeVisible();
  await expectTokenBackground(panel, "--sidebar");

  await page.getByTestId("theme-light").click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expectTokenBackground(panel, "--sidebar");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-u5-light.png"),
    fullPage: true,
  });

  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-u5-dark.png"),
    fullPage: true,
  });

  await page.getByTestId("state-loading").click();
  await expect(panel.getByRole("status")).toHaveText("Loading");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-u5-loading.png"),
    fullPage: true,
  });

  await page.getByTestId("state-error").click();
  await expect(panel.getByRole("alert")).toContainText("Panel data failed to load");
  await expectTokenBackground(panel, "--sidebar");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-u5-error.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/ui-blocks-panel-shell.html");
  await expect(panel).toHaveAttribute("data-panel-layout", "drawer");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-u5-narrow.png"),
    fullPage: true,
  });
  assertNoConsoleErrors();
});

test("captures migrated S1 section and settings rows in light/dark/narrow layouts", async ({
  page,
}) => {
  const assertNoConsoleErrors = trackConsoleErrors(page);
  const settings = page.getByRole("region", { name: "Appearance" });
  await page.goto("/ui-blocks-settings.html");
  await expect(settings).toBeVisible();
  await expectTokenBackground(settings, "--card");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-s1-light.png"),
    fullPage: true,
  });

  await page.goto("/ui-blocks-settings.html?theme=dark");
  await expect(settings).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectTokenBackground(settings, "--card");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-s1-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/ui-blocks-settings.html");
  await expect(settings).toBeVisible();
  await expectTokenBackground(settings, "--card");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "ui-blocks-s1-narrow.png"),
    fullPage: true,
  });
  assertNoConsoleErrors();
});
