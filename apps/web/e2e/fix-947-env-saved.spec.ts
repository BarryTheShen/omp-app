import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #947 on real omp: a setting that an environment variable overrides. The app starts omp with
 * PI_AUTO_QA=0, so Auto QA is off whatever is saved. Turning it on and saving writes the file, and the
 * section says so: the value is saved, omp still uses the variable, and the section names PI_AUTO_QA
 * instead of saying Applied.
 */

realTest.use({ serverEnv: { PI_AUTO_QA: "0" } });

const NOTICE = "Saved, but omp still uses the environment variable PI_AUTO_QA until it is removed.";

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  return settings;
}

// Selects one section of a tab and returns the panel that holds its controls.
async function openSection(settings: Locator, tab: string, title: string): Promise<Locator> {
  await settings.getByRole("button", { name: tab, exact: true }).click();
  await settings.getByRole("option", { name: title }).click();
  const panel = settings.getByRole("region", { name: `${tab} settings`, exact: true });
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

// The settings panels are styled from the design tokens: a probe with the token's colour must
// match the screen's computed background before anything is captured.
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

// Scrolls the thing under review into view inside the settings dialog, then captures the viewport.
async function capture(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await anchor.first().evaluate((element) => element.scrollIntoView({ block: "center" }));
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name) });
}

// Turns Auto QA on in the Developer settings and saves: the notice is the section's status after it.
async function saveAutoQa(page: Page): Promise<Locator> {
  const settings = await openSettings(page);
  const panel = await openSection(settings, "Tools", "Developer");
  const autoQa = panel.getByRole("checkbox", { name: "Auto QA", exact: true });
  await expect(autoQa).not.toBeChecked({ timeout: 20_000 });
  await autoQa.check();
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.click();
  await expect(save).toBeDisabled({ timeout: 20_000 });
  const notice = panel.getByText(NOTICE, { exact: true });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  // The save writes the file, and omp still uses the environment: Auto QA stays off, and nothing says Applied.
  await expect(autoQa).not.toBeChecked({ timeout: 20_000 });
  await expect(panel.getByText("Applied", { exact: true })).toHaveCount(0);
  return notice;
}

realTest(
  "a saved setting that the environment overrides names the variable, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });
    const notice = await saveAutoQa(page);
    await expectStyledSettings(page, "light");
    await capture(page, "fix-947-saved-light.png", notice);

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a saved setting that the environment overrides names the variable, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });
    const notice = await saveAutoQa(page);
    await expectStyledSettings(page, "dark");
    await capture(page, "fix-947-saved-dark.png", notice);

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a saved setting that the environment overrides still fits at 390 px, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const notice = await saveAutoQa(page);
    await expectStyledSettings(page, "dark");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await capture(page, "fix-947-saved-narrow-dark.png", notice);

    expect(realApp.problems).toEqual([]);
  },
);
