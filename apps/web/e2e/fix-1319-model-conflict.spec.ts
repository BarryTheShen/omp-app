import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #1319 on real omp: the Model tab's Thinking section. Another writer changes the same setting, so the section
 * holds a conflict: its fields and Save are disabled until the person chooses Reload or Keep mine. A Save pressed
 * twice writes once, so the person's own write never shows up as a conflict.
 */

const CONFLICT = "Another change arrived for Thinking Level";

type ConflictView = {
  readonly section: Locator;
  readonly level: Locator;
  readonly save: Locator;
  readonly conflict: Locator;
};

async function openModelThinking(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Model", exact: true }).click();
  const section = page.getByTestId("model-settings-thinking");
  await expect(section).toBeVisible({ timeout: 30_000 });
  return section;
}

// The settings panels are styled from the design tokens: a probe with the token's colour must match the
// screen's computed background before anything is captured.
async function expectStyledSettings(page: Page, theme: "light" | "dark"): Promise<void> {
  const settings = page.getByTestId("settings-screen");
  const colors = await settings.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--sidebar)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.actual).toBe(colors.token);
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function capture(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await anchor.scrollIntoViewIfNeeded();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

// Stages a Thinking Level change, then has another writer set the same setting: the section holds a conflict.
async function reachConflict(page: Page, agentDir: string): Promise<ConflictView> {
  const section = await openModelThinking(page);
  const level = section.getByRole("combobox", { name: "Thinking Level" });
  const save = section.getByRole("button", { name: "Save changes", exact: true });
  await expect(level).toBeEnabled({ timeout: 20_000 });
  await level.selectOption("high");
  await writeFile(join(agentDir, "config.yml"), "defaultThinkingLevel: minimal\n");
  // Save is either still enabled, so omp refuses its write and the conflict shows, or the change arrived first and
  // disabled it. A click on a disabled button does nothing, so the click needs no wait, and the conflict shows either way.
  await save.evaluate((button) => (button as HTMLButtonElement).click());
  const conflict = section.getByRole("alert").filter({ hasText: CONFLICT });
  await expect(conflict).toBeVisible({ timeout: 15_000 });
  return { section, level, save, conflict };
}

realTest(
  "a Thinking Level another writer changed is a conflict: fields and Save wait for a choice, then Keep mine saves",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });
    const { section, level, save, conflict } = await reachConflict(page, realApp.agentDir);

    await expect(level).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(conflict.getByRole("button", { name: "Reload", exact: true })).toBeEnabled();
    await expect(conflict.getByRole("button", { name: "Keep mine", exact: true })).toBeEnabled();
    await expectStyledSettings(page, "light");
    await capture(page, "fix-1319-conflict-light.png", conflict);

    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "fix-1319-conflict-narrow.png", conflict);

    await conflict.getByRole("button", { name: "Keep mine", exact: true }).click();
    await expect(conflict).toHaveCount(0);
    await expect(level).toBeEnabled();
    await save.click();
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"))
      .toContain("defaultThinkingLevel: high");
    await expect(section.getByText("Restart required", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the conflict and its disabled fields read the same in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });
    const { level, save, conflict } = await reachConflict(page, realApp.agentDir);
    await expect(level).toBeDisabled();
    await expect(save).toBeDisabled();
    await expectStyledSettings(page, "dark");
    await capture(page, "fix-1319-conflict-dark.png", conflict);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a Save pressed twice writes the Thinking Level once, with no conflict from the person's own write",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const section = await openModelThinking(page);
    const level = section.getByRole("combobox", { name: "Thinking Level" });
    const save = section.getByRole("button", { name: "Save changes", exact: true });
    await expect(level).toBeEnabled({ timeout: 20_000 });
    await level.selectOption("max");
    // Two clicks in one task: the second Save comes before the first one has written.
    await save.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"))
      .toContain("defaultThinkingLevel: max");
    await expect(section.getByText("Restart required", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(section.getByRole("alert").filter({ hasText: CONFLICT })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
