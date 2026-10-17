import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

realTest.setTimeout(300_000);

async function openThinkingControl(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Model", exact: true }).click();
  await dialog.getByRole("option", { name: "Thinking", exact: true }).click();
  const expand = dialog.getByRole("checkbox", { name: "Expand Thinking Blocks", exact: true });
  await expect(expand).toBeVisible();
  await expand.scrollIntoViewIfNeeded();
  return { dialog, expand };
}

async function expectStyledSettings(page: Page, theme: "light" | "dark"): Promise<void> {
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  const colors = await page.locator("[data-shell-layout]").evaluate((element) => {
    const tokenProbe = document.createElement("div");
    tokenProbe.style.backgroundColor = "var(--background)";
    document.body.append(tokenProbe);
    const token = getComputedStyle(tokenProbe).backgroundColor;
    tokenProbe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.actual).toBe(colors.token);
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function captureSettings(
  page: Page,
  theme: "light" | "dark",
  screenshot: string,
): Promise<{ dialog: Locator; expand: Locator }> {
  const { dialog, expand } = await openThinkingControl(page);
  await expectStyledSettings(page, theme);
  await expand.scrollIntoViewIfNeeded();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, screenshot), fullPage: true });
  return { dialog, expand };
}

realTest("saves the expand thinking blocks setting to omp config", async ({ realApp }) => {
  await mkdir(screenshots, { recursive: true });
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const light = await captureSettings(page, "light", "d1-expand-thinking-light.png");

  const dark = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await dark.setViewportSize({ width: 1280, height: 900 });
  await captureSettings(dark, "dark", "d1-expand-thinking-dark.png");
  await dark.setViewportSize({ width: 390, height: 844 });
  const darkExpand = dark.getByRole("checkbox", { name: "Expand Thinking Blocks", exact: true });
  await darkExpand.scrollIntoViewIfNeeded();
  await expect(darkExpand).toBeVisible();
  await expectStyledSettings(dark, "dark");
  await waitForFiniteAnimations(dark);
  await dark.screenshot({ path: join(screenshots, "d1-expand-thinking-390.png"), fullPage: true });

  const { dialog, expand } = light;
  await expect(expand).not.toBeChecked();
  await expand.check();
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await expect
    .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
    .toMatch(/(?:^|\n)\s*expandThinkingBlocks:\s*true\s*(?:\n|$)/);

  await page.reload();
  const reloaded = await openThinkingControl(page);
  await expect(reloaded.expand).toBeChecked();
  expect(realApp.problems).toEqual([]);
});
