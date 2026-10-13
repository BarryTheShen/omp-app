import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #1317 on real omp: a Model setting omp refuses to write. The settings file holds `providers` as a plain
 * value, so omp cannot write `providers.autoThinkingMaxEffort` under it. The Model tab names that setting and
 * omp's reason, marks its row, does not say Applied, and the next save is not reported as a conflict.
 */

const NOT_SAVED = "Not saved: Auto Thinking Ceiling.";
const REFUSAL =
  "This setting could not be written to the settings file. Check the settings file for an entry that conflicts with it.";

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

// Scrolls the notice into view, waits for the animations to finish, then captures the page.
async function capture(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await anchor.scrollIntoViewIfNeeded();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

// Changes Auto Thinking Ceiling and saves: omp refuses that write, so the setting stays unsaved.
async function saveRefused(page: Page): Promise<Locator> {
  const section = await openModelThinking(page);
  const ceiling = section.getByRole("combobox", { name: "Auto Thinking Ceiling" });
  await expect(ceiling).toBeVisible({ timeout: 20_000 });
  const before = await ceiling.inputValue();
  await ceiling.selectOption(before === "max" ? "xhigh" : "max");
  await section.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText(NOT_SAVED, { exact: true })).toBeVisible({ timeout: 20_000 });
  return section;
}

realTest(
  "a Model save omp refuses names the setting and omp's reason, with no Applied, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await writeFile(join(realApp.agentDir, "config.yml"), "providers: not-a-section\n");
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });
    const section = await saveRefused(page);
    const save = section.getByRole("button", { name: "Save changes", exact: true });

    await expect(page.getByText(REFUSAL, { exact: true })).toBeVisible();
    await expect(section.getByText("Applied", { exact: true })).toHaveCount(0);
    await expect(section.getByText("Not saved", { exact: true })).toHaveCount(1);
    await expect(save).toBeEnabled();
    await expectStyledSettings(page, "light");
    const notice = page.getByText(NOT_SAVED, { exact: true });
    await capture(page, "fix-1317-model-save-light.png", notice);

    // The refused setting stays staged. The next save is refused for the same reason, and it is not
    // reported as a conflict with a change nobody else made.
    await save.click();
    await expect(page.getByText(NOT_SAVED, { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Another change arrived")).toHaveCount(0);
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"))
      .not.toContain("autoThinkingMaxEffort");

    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "fix-1317-model-save-narrow.png", notice);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a Model save omp refuses names the setting and omp's reason, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await writeFile(join(realApp.agentDir, "config.yml"), "providers: not-a-section\n");
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });
    const section = await saveRefused(page);
    await expect(page.getByText(REFUSAL, { exact: true })).toBeVisible();
    await expect(section.getByText("Applied", { exact: true })).toHaveCount(0);
    await expectStyledSettings(page, "dark");
    await capture(page, "fix-1317-model-save-dark.png", page.getByText(NOT_SAVED, { exact: true }));
    expect(realApp.problems).toEqual([]);
  },
);
