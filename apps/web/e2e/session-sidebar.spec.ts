/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const PLAYGROUND = "/r1-session-sidebar-playground.html";
const SCREENSHOT_ROOT = join(APP_ROOT, "../../.data/screenshots");

function buildPlaygroundPage(): void {
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/R1/ui/session-sidebar-playground.tsx",
      "--outfile",
      "dist/r1-session-sidebar-playground.js",
      "--target=browser",
    ],
    { cwd: APP_ROOT, stdio: "inherit" },
  );
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for the R1 sidebar.");
  mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  writeFileSync(
    join(DIST_ROOT, "r1-session-sidebar-playground.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <title>omp R1 session sidebar playground</title>
  </head>
  <body>
    <div id="r1-session-sidebar-playground-root"></div>
    <script type="module" src="/r1-session-sidebar-playground.js"></script>
  </body>
</html>
`,
  );
}

function trackConsoleErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return () => expect(errors, errors.join("\n")).toEqual([]);
}

async function expectCatalogReady(page: Page): Promise<void> {
  const sidebar = page.locator('[data-testid="r1-session-sidebar"]');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.getByText("Pinned project kickoff")).toBeVisible();
  await expect(sidebar.getByRole("heading", { name: "project", exact: true })).toHaveAttribute(
    "title",
    "/workspace/project",
  );
  await expect(sidebar.getByRole("heading", { name: "worktree", exact: true })).toHaveAttribute(
    "title",
    "/workspace/project/worktree",
  );
}

async function expectStylesLoaded(page: Page): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute(
    "href",
    /\/assets\/.+\.css$/,
  );
  const background = await page
    .locator('[data-testid="r1-session-sidebar"] aside[aria-label="Session list"]')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

test.beforeAll(() => ensurePlaygroundBuilt(buildPlaygroundPage));

test("captures the light grouped catalog with pinned, recent, branch and long-title previews", async ({
  page,
}) => {
  const assertNoConsoleErrors = trackConsoleErrors(page);
  await page.goto(PLAYGROUND);
  await expectCatalogReady(page);
  await expect(
    page.locator(
      '[data-testid="r1-session-sidebar"] [data-slot="r1-session-row"][data-selected="true"]',
    ),
  ).toContainText("Pinned project kickoff");
  await expect(page.getByText("main").first()).toBeVisible();
  await expect(page.getByText(/A very long session title/)).toBeVisible();
  await expectStylesLoaded(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "r1-6-session-sidebar-light.png"),
    fullPage: true,
  });
  assertNoConsoleErrors();
});

test("captures dark mode and disabled delete/archive capability reasons", async ({ page }) => {
  const assertNoConsoleErrors = trackConsoleErrors(page);
  await page.context().addInitScript({
    content:
      'document.addEventListener("DOMContentLoaded", () => document.documentElement.classList.add("dark"), { once: true })',
  });
  await page.goto(PLAYGROUND);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expectCatalogReady(page);
  await expect(page.locator("html")).toHaveClass(/dark/);

  const row = page.getByRole("option", { name: /Pinned project kickoff/ });
  await row.hover();
  const sidebar = page.locator('[data-testid="r1-session-sidebar"]');
  const trigger = sidebar.getByRole("button", { name: "More actions for Pinned project kickoff" });
  await trigger.click();
  const menu = sidebar.getByRole("menu", { name: "Actions for Pinned project kickoff" });
  const deleteButton = menu.getByRole("menuitem", { name: "Delete Pinned project kickoff" });
  const archiveButton = menu.getByRole("menuitem", { name: "Archive Pinned project kickoff" });
  await expect(deleteButton).toBeDisabled();
  await expect(deleteButton).toHaveAttribute(
    "title",
    "Deleting a chat isn't available in the app yet.",
  );
  await expect(archiveButton).toBeDisabled();
  await expect(archiveButton).toHaveAttribute("title", "Needs a newer version of omp.");
  await expectStylesLoaded(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "r1-6-session-sidebar-dark.png"),
    fullPage: true,
  });
  assertNoConsoleErrors();
});

test("captures search highlighting and inline rename", async ({ page }) => {
  const assertNoConsoleErrors = trackConsoleErrors(page);
  await page.goto(PLAYGROUND);
  await expectCatalogReady(page);
  const sidebar = page.locator('[data-testid="r1-session-sidebar"]');
  const search = sidebar.getByRole("textbox", { name: "Search sessions" });
  await search.fill("long session");
  await expect(sidebar.locator("mark")).toContainText("long session");
  await expectStylesLoaded(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "r1-6-session-sidebar-search.png"),
    fullPage: true,
  });

  await search.fill("");
  const row = page.getByRole("option", { name: /Pinned project kickoff/ });
  await row.hover();
  await sidebar.getByRole("button", { name: "More actions for Pinned project kickoff" }).click();
  await sidebar
    .getByRole("menu", { name: "Actions for Pinned project kickoff" })
    .getByRole("menuitem", { name: "Rename Pinned project kickoff" })
    .click();
  const renameInput = sidebar.getByRole("textbox", { name: "Rename Pinned project kickoff" });
  await expect(renameInput).toBeVisible();
  await renameInput.fill("Renamed fixture session");
  await expectStylesLoaded(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "r1-6-session-sidebar-rename.png"),
    fullPage: true,
  });
  assertNoConsoleErrors();
});

test("captures the narrow U0 left drawer", async ({ page }) => {
  const assertNoConsoleErrors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PLAYGROUND);
  await expect(page.locator('[data-shell-layout="narrow"]')).toBeVisible();
  await expect(page.locator('[data-shell-sidebar="left"]')).toBeHidden();
  await page.getByRole("button", { name: "Show sessions sidebar" }).click();
  await expect(page.locator('[data-shell-sidebar="left"]')).toBeVisible();
  await expectCatalogReady(page);
  await expect(page.locator('[data-shell-drawer-backdrop="true"]')).toBeVisible();
  await expectStylesLoaded(page);
  await page.screenshot({
    path: join(SCREENSHOT_ROOT, "r1-6-session-sidebar-narrow-drawer.png"),
    fullPage: true,
  });
  assertNoConsoleErrors();
});

// Feedback #661: with about 20 sessions the list was cut off at the bottom of the window and the
// older ones could not be reached, because the sidebar's content box had no height of its own.
for (const height of [600, 844, 1659]) {
  test(`a long session list scrolls inside the sidebar at ${height} px tall, and the controls above it stay put`, async ({
    page,
  }) => {
    const assertNoConsoleErrors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1280, height });
    await page.goto(`${PLAYGROUND}?sessions=60`);
    await expectCatalogReady(page);
    const list = page.getByRole("listbox", { name: "Session list" });
    const newChat = page.getByRole("button", { name: "New chat" }).first();
    const search = page.getByRole("textbox", { name: "Search sessions" });
    const controlsBefore = [await newChat.boundingBox(), await search.boundingBox()];

    // The list is taller than its box, so it scrolls; the window itself does not.
    const metrics = await list.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      bottom: element.getBoundingClientRect().bottom,
    }));
    expect(metrics.overflowY).toBe("auto");
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.bottom).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
      height,
    );

    // The wheel reaches the last row of the list, and the controls above did not move.
    const last = page.getByRole("option", { name: /Recent worktree chat 5/ });
    await expect(last).not.toBeInViewport();
    await list.hover();
    await page.mouse.wheel(0, 50_000);
    await expect(last).toBeInViewport();
    expect([await newChat.boundingBox(), await search.boundingBox()]).toEqual(controlsBefore);

    await page.screenshot({
      path: join(SCREENSHOT_ROOT, `r1-6-session-sidebar-long-list-${height}.png`),
      fullPage: true,
    });
    assertNoConsoleErrors();
  });
}

test("a long panel scrolls inside the right-hand sidebar, with its title staying put", async ({
  page,
}) => {
  const assertNoConsoleErrors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`${PLAYGROUND}?panelRows=80`);
  await expectCatalogReady(page);
  // The Panels start closed on a first run (#2570): open them to measure their body.
  await page.getByRole("button", { name: "Show panels sidebar" }).click();
  await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute("data-open", "true");
  const body = page.locator('[data-panel-scroll="body"]');
  const metrics = await body.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    bottom: element.getBoundingClientRect().bottom,
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.bottom).toBeLessThanOrEqual(600);

  const last = page.getByText("Note 80", { exact: true });
  await expect(last).not.toBeInViewport();
  await body.hover();
  await page.mouse.wheel(0, 50_000);
  await expect(last).toBeInViewport();
  await expect(page.getByRole("heading", { name: "Notes" })).toBeInViewport();
  assertNoConsoleErrors();
});
