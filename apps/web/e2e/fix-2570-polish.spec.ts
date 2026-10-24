import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { test } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";
import {
  isLabelKey,
  markProbe,
  movesIn,
  pressWindows,
  startProbe,
  stopProbe,
} from "./thinking-cycle-probe";

/**
 * Issue #2570 (polish), on the real app with real omp:
 * 1. Settings opens on the first page whose settings change the app (Interaction). Appearance, whose settings change
 *    only omp's terminal, comes last.
 * 2. The wide layout's right panel starts closed on a first run, and keeps the choice the person last made.
 * 3. The status bar draws the folder's name, the git branch, the model with its thinking level, and the context use.
 *    At 1280 px each is whole; at 390 px the items that fit are kept whole, and the rest are left out, never cut.
 * Screenshots: light and dark at 1280 px, and at 390 px, in .data/screenshots.
 */

/** The branch the seeded folder switches to, so the bar's branch text is known. */
const BRANCH = "fix-2570-polish";

realTest.use({ seedWorkspace: { files: { "README.md": "# Seeded folder\n" }, gitRepo: true } });

/**
 * Commits the seeded files and switches to BRANCH. `git init` alone leaves the branch with no commits, and the bar
 * shows a branch with no commits as unavailable.
 */
function commitOnBranch(folder: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { stdio: "ignore" });
  git("add", "-A");
  git(
    "-c",
    "user.name=omp-app e2e",
    "-c",
    "user.email=e2e@example.invalid",
    "commit",
    "-q",
    "-m",
    "Seed the folder",
  );
  git("switch", "-q", "-c", BRANCH);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
}

/** Waits until the shell has its theme's colours, so a screenshot shows the real styles and not the browser's defaults. */
async function expectStyled(page: Page, theme: "light" | "dark"): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((shell) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(shell).backgroundColor, token };
  });
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.actual).toBe(colors.token);
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

/** One status segment by its N2 row id: drawn, hidden or absent. */
function segment(page: Page, id: string) {
  return page
    .getByRole("region", { name: "Session and workspace status" })
    .locator(`[data-segment="${id}"]`);
}

/** No drawn value is cut short: each is as wide as its text, and none shows an ellipsis. */
async function expectWholeValues(page: Page): Promise<void> {
  const values = page
    .getByRole("region", { name: "Session and workspace status" })
    .locator("[data-segment-value]");
  const cut = await values.evaluateAll((elements) =>
    elements
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((e) => e.textContent),
  );
  expect(cut, "values cut short").toEqual([]);
  for (const text of await values.allTextContents()) expect(text).not.toContain("…");
}

/** The segments the bar must not draw: the rows that moved out of sight, and the ones that are absent. */
const NOT_DRAWN = [
  "N2.pi",
  "N2.hostname",
  "N2.session",
  "N2.session-name",
  "N2.time",
  "N2.time-spent",
  "N2.pr",
  "N2.subagents",
  "N2.collab",
];

const LIGHT = (target: Page) =>
  target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light"));
const DARK = (target: Page) =>
  target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));

realTest(
  "light at 1280 px: Settings opens on Interaction, the panel starts closed, and the bar draws its four items whole",
  async ({ realApp }) => {
    test.slow();
    commitOnBranch(realApp.folder);
    const page = await realApp.open({ beforeLoad: LIGHT });
    await page.setViewportSize({ width: 1280, height: 900 });
    await mkdir(screenshots, { recursive: true });

    // A first run: the wide layout's right panel is closed.
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );

    // Settings opens on the first page whose settings change the app. Appearance is terminal-only, so it comes last.
    await openSettings(page);
    const tabs = page.locator('[aria-label="Settings categories"] button');
    await expect(tabs.first()).toHaveText("Interaction");
    await expect(tabs.last()).toHaveText("Appearance");
    await expect(page.getByRole("button", { name: "Interaction", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      page.getByText(
        "These settings change omp's terminal only, except Block Images and Auto-Resize Images, which also change this app's chats.",
        {
          exact: true,
        },
      ),
    ).toBeHidden();
    await expectStyled(page, "light");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2570-settings-light.png") });
    await page.getByRole("button", { name: "Close settings" }).click();

    // The bar draws the folder's name, the branch, the model and the context; the other rows are not drawn.
    await startChat(page);
    await expect(page.getByRole("region", { name: "Session and workspace status" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(segment(page, "N2.path").locator("[data-segment-value]")).toHaveText(
      basename(realApp.folder),
    );
    await expect(segment(page, "N2.git").locator("[data-segment-value]")).toHaveText(BRANCH);
    await expect(segment(page, "N2.model").locator("[data-segment-value]")).toContainText(
      "Fake Model",
    );
    await expect(page.getByRole("region", { name: "Context status" })).toContainText(
      /Context \d+%/,
    );
    for (const id of NOT_DRAWN) await expect(segment(page, id), id).toHaveCount(0);
    await expectWholeValues(page);

    // The folder's tooltip carries the full path, the server and the session.
    const folderTitle = await segment(page, "N2.path").getAttribute("title");
    const parent = basename(dirname(realApp.folder));
    expect(folderTitle).toContain(`${parent}/${basename(realApp.folder)}`);
    expect(folderTitle).toMatch(/^Workspace folder: /m);
    expect(folderTitle).toMatch(/^Server ID: \S+/m);
    expect(folderTitle).toMatch(/^Session ID: \S+/m);

    await expectStyled(page, "light");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2570-chat-light.png") });
    await page
      .locator('[data-layout-area="statusBar"]')
      .screenshot({ path: join(screenshots, "fix-2570-status-light.png") });

    // The choice the person makes holds across a reload.
    await page.getByRole("button", { name: "Show panels sidebar" }).click();
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute("data-open", "true");
    await page.reload();
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute("data-open", "true");
    await page.getByRole("button", { name: "Hide panels sidebar" }).click();
    await page.reload();
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "dark at 1280 px, then 390 px: the same screens in dark, and the bar keeps what fits whole",
  async ({ realApp }) => {
    test.slow();
    commitOnBranch(realApp.folder);
    const page = await realApp.open({ beforeLoad: DARK });
    await page.setViewportSize({ width: 1280, height: 900 });
    await mkdir(screenshots, { recursive: true });

    await openSettings(page);
    await expect(page.getByRole("button", { name: "Interaction", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectStyled(page, "dark");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2570-settings-dark.png") });
    await page.getByRole("button", { name: "Close settings" }).click();

    await startChat(page);
    await expect(segment(page, "N2.model").locator("[data-segment-value]")).toContainText(
      "Fake Model",
    );
    await expect(segment(page, "N2.git").locator("[data-segment-value]")).toHaveText(BRANCH);
    await expectWholeValues(page);
    await expectStyled(page, "dark");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2570-chat-dark.png") });
    await page
      .locator('[data-layout-area="statusBar"]')
      .screenshot({ path: join(screenshots, "fix-2570-status-dark.png") });

    // At 390 px the folder and the model fit whole; the branch does not fit beside them, so it is left out, not cut.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await waitForFiniteAnimations(page);
    // The model is kept first; the folder shows when it fits beside the model, and is left out whole when it does not.
    await expect(segment(page, "N2.model")).toBeVisible();
    await expect(segment(page, "N2.git")).toBeHidden();
    await expectWholeValues(page);
    const bar = await page.locator('[data-layout-area="statusBar"]').boundingBox();
    expect(bar?.width ?? 0).toBeLessThanOrEqual(390);
    await expectStyled(page, "dark");
    await page.screenshot({ path: join(screenshots, "fix-2570-chat-390-dark.png") });
    await page
      .locator('[data-layout-area="statusBar"]')
      .screenshot({ path: join(screenshots, "fix-2570-status-390-dark.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "light at 390 px: Settings still opens on Interaction, and the bar keeps what fits whole",
  async ({ realApp }) => {
    test.slow();
    commitOnBranch(realApp.folder);
    const page = await realApp.open({ beforeLoad: LIGHT });
    await page.setViewportSize({ width: 1280, height: 900 });
    await mkdir(screenshots, { recursive: true });

    await startChat(page);
    await openSettings(page);
    await expect(page.getByRole("button", { name: "Interaction", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await expectStyled(page, "light");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2570-settings-390-light.png") });
    await page.getByRole("button", { name: "Close settings" }).click();
    await waitForFiniteAnimations(page);

    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await expect(segment(page, "N2.model")).toBeVisible();
    await expect(segment(page, "N2.git")).toBeHidden();
    await expectWholeValues(page);
    await expectStyled(page, "light");
    await page.screenshot({ path: join(screenshots, "fix-2570-chat-390-light.png") });
    await page
      .locator('[data-layout-area="statusBar"]')
      .screenshot({ path: join(screenshots, "fix-2570-status-390-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);

/** The text the Appearance page shows under its heading: which of its settings also change this app's chats. */
const SCOPE_NOTE =
  "These settings change omp's terminal only, except Block Images and Auto-Resize Images, which also change this app's chats.";

/** Alt+K presses per viewport: more than the levels a model offers, so every level is reached and the cycle wraps. */
const CYCLE_PRESSES = 7;

realTest(
  "light at 1280 px, then 390 px: while the thinking level cycles, the status bar keeps every other segment in place and the model keeps one width",
  async ({ realApp }) => {
    test.slow();
    commitOnBranch(realApp.folder);
    const page = await realApp.open({ beforeLoad: LIGHT });
    await page.setViewportSize({ width: 1280, height: 900 });
    await startChat(page);
    await waitForFiniteAnimations(page);
    await expect(segment(page, "N2.model")).toBeVisible();

    await startProbe(page, "status");
    for (const viewport of [
      { name: "1280", width: 1280, height: 900 },
      { name: "390", width: 390, height: 844 },
    ]) {
      await markProbe(page, "resize", 0, viewport.name);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await waitForFiniteAnimations(page);
      for (let press = 1; press <= CYCLE_PRESSES; press += 1) {
        await markProbe(page, "press", press, viewport.name);
        await page.keyboard.press("Alt+k");
        await page.waitForTimeout(1_500);
      }
    }
    const windows = pressWindows(await stopProbe(page));
    expect(windows).toHaveLength(2 * CYCLE_PRESSES);
    // The probe must have seen the bar: an empty sample would pass every check below.
    expect(
      Object.keys(windows[0]?.baseline.boxes ?? {}).filter((key) =>
        key.includes("segment:N2.model"),
      ),
      "the probe found the status bar's model segment",
    ).toHaveLength(1);
    const moves = windows.flatMap(({ mark, baseline, frames }) =>
      movesIn(baseline, frames).map((move) => ({
        viewport: mark.viewport,
        press: mark.index,
        ...move,
      })),
    );
    expect(
      moves.filter((move) => !isLabelKey(move.key)),
      "status-bar boxes other than the model moved while the level cycled",
    ).toEqual([]);
    expect(
      moves.filter((move) => isLabelKey(move.key)),
      "the model segment changed its box while the level cycled",
    ).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "light: the Appearance page, last in Settings, names the two settings that also change this app's chats, at 1280 px and at 390 px",
  async ({ realApp }) => {
    test.slow();
    commitOnBranch(realApp.folder);
    const page = await realApp.open({ beforeLoad: LIGHT });
    await page.setViewportSize({ width: 1280, height: 900 });
    await mkdir(screenshots, { recursive: true });
    await startChat(page);
    await openSettings(page);
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(page.getByText(SCOPE_NOTE, { exact: true })).toBeVisible();
    await waitForFiniteAnimations(page);
    await expectStyled(page, "light");
    await page.screenshot({ path: join(screenshots, "fix-2570-appearance-light-1280.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expect(page.getByText(SCOPE_NOTE, { exact: true })).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-2570-appearance-light-390.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "dark: the Appearance page names the two settings that also change this app's chats, at 1280 px and at 390 px",
  async ({ realApp }) => {
    test.slow();
    commitOnBranch(realApp.folder);
    const page = await realApp.open({ beforeLoad: DARK });
    await page.setViewportSize({ width: 1280, height: 900 });
    await mkdir(screenshots, { recursive: true });
    await startChat(page);
    await openSettings(page);
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(page.getByText(SCOPE_NOTE, { exact: true })).toBeVisible();
    await waitForFiniteAnimations(page);
    await expectStyled(page, "dark");
    await page.screenshot({ path: join(screenshots, "fix-2570-appearance-dark-1280.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expect(page.getByText(SCOPE_NOTE, { exact: true })).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-2570-appearance-dark-390.png") });
    expect(realApp.problems).toEqual([]);
  },
);
