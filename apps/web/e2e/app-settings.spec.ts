import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
}

async function expectStyledSettings(page: Page, theme: "light" | "dark"): Promise<void> {
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  const shellColors = await page.locator("[data-shell-layout]").evaluate((element) => {
    const tokenProbe = document.createElement("div");
    tokenProbe.style.backgroundColor = "var(--background)";
    document.body.append(tokenProbe);
    const token = getComputedStyle(tokenProbe).backgroundColor;
    tokenProbe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  const panelColors = await settings.evaluate((element) => {
    const tokenProbe = document.createElement("div");
    tokenProbe.style.backgroundColor = "var(--sidebar)";
    document.body.append(tokenProbe);
    const token = getComputedStyle(tokenProbe).backgroundColor;
    tokenProbe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  expect(shellColors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(shellColors.actual).toBe(shellColors.token);
  expect(panelColors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(panelColors.actual).toBe(panelColors.token);
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

realTest("opens core settings and renders light, dark, and narrow layouts", async ({ realApp }) => {
  test.slow();
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
  });
  await openSettings(page);

  await expect(page.getByRole("button", { name: "Appearance", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("Save settings to", { exact: true })).toBeVisible();
  await expect(page.getByText("Dark Theme", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("These settings change omp's terminal only. This app does not use them.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Terminal preview", exact: true })).toBeVisible();
  const appearanceTabs = page
    .getByRole("tablist", { name: "Appearance sections", exact: true })
    .getByRole("tab");
  expect(await appearanceTabs.count()).toBeGreaterThan(1);
  await appearanceTabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(appearanceTabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(appearanceTabs.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(appearanceTabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /Choose dark theme/ })).toHaveCount(0);
  await expectStyledSettings(page, "light");
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "app-settings-light.png"), fullPage: true });

  await page.getByRole("button", { name: "Interaction", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Interaction settings sections" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Interaction settings" })).toBeVisible();
  const steeringMode = page.getByText("Steering Mode", { exact: true });
  await steeringMode.scrollIntoViewIfNeeded();
  await expect(steeringMode).toBeVisible();
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Model settings sections" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Model settings" })).toBeVisible();
  const thinkingLevel = page.getByText("Thinking Level", { exact: true });
  await thinkingLevel.scrollIntoViewIfNeeded();
  await expect(thinkingLevel).toBeVisible();

  const dark = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await openSettings(dark);
  await expectStyledSettings(dark, "dark");
  await expect(dark.getByText("Dark Theme", { exact: true })).toHaveCount(0);
  await expect(dark.getByRole("button", { name: /Choose dark theme/ })).toHaveCount(0);
  await waitForFiniteAnimations(dark);
  await dark.screenshot({ path: join(screenshots, "app-settings-dark.png"), fullPage: true });

  await dark.setViewportSize({ width: 390, height: 844 });
  await expectStyledSettings(dark, "dark");
  await expect(dark.getByRole("button", { name: "Interaction", exact: true })).toBeVisible();
  await waitForFiniteAnimations(dark);
  await dark.screenshot({ path: join(screenshots, "app-settings-narrow.png"), fullPage: true });
  expect(realApp.problems).toEqual([]);
});
