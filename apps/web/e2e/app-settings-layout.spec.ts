import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * The settings dialog on real omp (#882). A long section's descriptions use the dialog's width
 * instead of a narrow strip beside each control, and the dialog's title stays whole when the dialog
 * scrolls. Each case captures the result in light, dark and at 390 px.
 */

const DESCRIPTION =
  "Save tool output as an artifact when it exceeds this size; keep the tail inline.";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("expected the element to be on the screen");
  return box;
}

async function openOutputLimits(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Tools", exact: true }).click();
  await dialog.getByRole("option", { name: "Tools / Output Limits", exact: true }).click();
  await expect(dialog.getByText(DESCRIPTION, { exact: true })).toBeVisible({ timeout: 20_000 });
  return dialog;
}

// The settings panels are styled from the design tokens: the panel's computed background must match
// the token before anything is captured, so a capture cannot show unstyled browser defaults.
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

async function expectReadableDialog(dialog: Locator): Promise<void> {
  const frame = await boxOf(dialog);
  const description = await boxOf(dialog.getByText(DESCRIPTION, { exact: true }));
  // The description uses the dialog's width: at least half of it, not a narrow column beside the control.
  expect(description.width).toBeGreaterThanOrEqual(frame.width / 2);

  // Scroll the dialog to its end, as a person does by scrolling past the last setting.
  await dialog.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const title = await boxOf(dialog.getByRole("heading", { name: "Settings", exact: true }));
  // The title's whole box stays inside the dialog while the dialog scrolls.
  expect(title.y).toBeGreaterThanOrEqual(frame.y);
  expect(title.y + title.height).toBeLessThanOrEqual(frame.y + frame.height);
}

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name) });
}

realTest(
  "at 1280 px the settings descriptions use the dialog's width and the title stays whole, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openOutputLimits(page);
    await expectStyledSettings(page, "light");
    await expectReadableDialog(dialog);
    await capture(page, "app-settings-layout-light.png");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "at 1280 px the settings descriptions use the dialog's width and the title stays whole, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openOutputLimits(page);
    await expectStyledSettings(page, "dark");
    await expectReadableDialog(dialog);
    await capture(page, "app-settings-layout-dark.png");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "at 390 px the settings dialog reads whole and does not scroll its title away",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await openOutputLimits(page);
    await expectStyledSettings(page, "dark");
    await expectReadableDialog(dialog);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await capture(page, "app-settings-layout-narrow.png");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the settings dialog is wide on a desktop window and fits a phone (#961)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openOutputLimits(page);
    // The dialog was a 512 px strip on a 1280 px window. It is now most of the window, not all of it.
    expect((await boxOf(dialog)).width).toBeGreaterThanOrEqual(900);
    await page.setViewportSize({ width: 1920, height: 1080 });
    expect((await boxOf(dialog)).width).toBeGreaterThanOrEqual(900);
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await boxOf(dialog)).width).toBeLessThanOrEqual(390 * 0.94 + 1);
    expect(realApp.problems).toEqual([]);
  },
);

const SETTINGS_TABS_LABEL = "Settings categories";

/** Every tab of the settings screen at one width and theme: the dialog must fit, and each tab is captured. */
async function captureEveryTab(page: Page, width: number, theme: "light" | "dark"): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const tabs = dialog.getByRole("group", { name: SETTINGS_TABS_LABEL, exact: true });
  const names: string[] = [];
  const buttons = tabs.getByRole("button");
  for (let index = 0; index < (await buttons.count()); index++) {
    names.push((await buttons.nth(index).innerText()).trim());
  }
  expect(names.length).toBeGreaterThanOrEqual(6);
  for (const name of names) {
    const tab = tabs.getByRole("button", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-pressed", "true");
    // Appearance has its own panel; the other tabs list their sections.
    if (name !== "Appearance") {
      await expect(page.getByRole("listbox", { name: `${name} settings sections` })).toBeVisible({
        timeout: 20_000,
      });
    }
    const box = await boxOf(dialog);
    if (width >= 1280) {
      expect(box.width, `${name} at ${width} px`).toBeGreaterThanOrEqual(900);
    } else {
      expect(box.width, `${name} at ${width} px`).toBeLessThanOrEqual(width * 0.94 + 1);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${name} at ${width} px scrolls sideways`).toBeLessThanOrEqual(0);
    await waitForFiniteAnimations(page);
    const file = name.toLowerCase().replace(/[^a-z]+/g, "-");
    await dialog.screenshot({ path: join(screenshots, `settings-${file}-${width}-${theme}.png`) });
  }
}

for (const [width, theme] of [
  [1280, "light"],
  [1280, "dark"],
  [1920, "light"],
  [1920, "dark"],
  [390, "light"],
  [390, "dark"],
] as const) {
  realTest(
    `every settings tab fits and reads at ${width} px in ${theme} (#961)`,
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(
            (value) => window.localStorage.setItem("omp-app.theme", value),
            theme,
          ),
      });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
      await captureEveryTab(page, width, theme);
      expect(realApp.problems).toEqual([]);
    },
  );
}
