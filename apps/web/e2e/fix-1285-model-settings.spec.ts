import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Model settings sections" })).toBeVisible();
}

async function showSection(page: Page, title: string): Promise<void> {
  await page.getByRole("option", { name: title, exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}

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

realTest(
  "D1 model settings show the fallback and image URL controls in every layout",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 2200 });
    await openSettings(page);
    await expectStyledSettings(page, "light");

    await showSection(page, "Retry & Fallback");
    await expect(page.getByText("Retry Fallback Chains", { exact: true })).toBeVisible();
    await page.getByText("Retry Fallback Chains", { exact: true }).scrollIntoViewIfNeeded();
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d1-retry-fallback-light.png"),
      fullPage: true,
    });

    await showSection(page, "Vision");
    await expect(page.getByText("Serve Images as URLs", { exact: true })).toBeVisible();
    await expect(page.getByText("Image URL SSH Remote Port", { exact: true })).toBeVisible();
    await page.getByText("Serve Images as URLs", { exact: true }).scrollIntoViewIfNeeded();
    await expectStyledSettings(page, "light");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d1-image-urls-light.png"),
      fullPage: true,
    });
    await page.getByText("Image URL SSH Remote Port", { exact: true }).scrollIntoViewIfNeeded();
    await expectStyledSettings(page, "light");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d1-image-urls-light-bottom.png"),
      fullPage: true,
    });

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await dark.setViewportSize({ width: 1280, height: 2200 });
    await openSettings(dark);
    await showSection(dark, "Retry & Fallback");
    await expect(dark.getByText("Retry Fallback Chains", { exact: true })).toBeVisible();
    await dark.getByText("Retry Fallback Chains", { exact: true }).scrollIntoViewIfNeeded();
    await expectStyledSettings(dark, "dark");
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "d1-retry-fallback-dark.png"),
      fullPage: true,
    });

    await showSection(dark, "Vision");
    await expect(dark.getByText("Serve Images as URLs", { exact: true })).toBeVisible();
    await dark.getByText("Serve Images as URLs", { exact: true }).scrollIntoViewIfNeeded();
    await expectStyledSettings(dark, "dark");
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "d1-image-urls-dark.png"),
      fullPage: true,
    });
    await dark.getByText("Image URL SSH Remote Port", { exact: true }).scrollIntoViewIfNeeded();
    await expectStyledSettings(dark, "dark");
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "d1-image-urls-dark-bottom.png"),
      fullPage: true,
    });

    await dark.setViewportSize({ width: 390, height: 2200 });
    await showSection(dark, "Retry & Fallback");
    await expect(dark.getByText("Retry Fallback Chains", { exact: true })).toBeVisible();
    await dark.getByText("Retry Fallback Chains", { exact: true }).scrollIntoViewIfNeeded();
    await expectStyledSettings(dark, "dark");
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "d1-retry-fallback-390.png"),
      fullPage: true,
    });

    await showSection(dark, "Vision");
    await expect(dark.getByText("Image URL SSH Remote Port", { exact: true })).toBeVisible();
    await dark
      .getByText("Serve Images as URLs", { exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expectStyledSettings(dark, "dark");
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "d1-image-urls-390.png"),
      fullPage: true,
    });
    await dark.getByText("Image URL SSH Remote Port", { exact: true }).scrollIntoViewIfNeeded();
    await expectStyledSettings(dark, "dark");
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "d1-image-urls-390-bottom.png"),
      fullPage: true,
    });

    await dark.getByRole("checkbox", { name: "Serve Images as URLs", exact: true }).check();
    await dark.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dark.getByText("Applied", { exact: true })).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);
