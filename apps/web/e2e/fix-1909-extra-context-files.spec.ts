import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function openGeneral(
  page: Page,
): Promise<{ readonly settings: Locator; readonly section: Locator }> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Context", exact: true }).click();
  await expect(settings.getByRole("tab", { name: "General", exact: true })).toBeVisible();
  await settings.getByRole("tab", { name: "General", exact: true }).click();
  const section = settings.locator('[data-p7-context-section="P7.contextGeneral"]');
  await expect(section).toBeVisible();
  return { settings, section };
}

realTest(
  "P7 extra context filenames validate, save and reload through omp",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1500 });
    const { section } = await openGeneral(page);
    const files = section.getByRole("textbox", { name: "Extra Context Files", exact: true });
    await expect(files).toHaveValue("");
    await expect(section.getByText("Source: omp's default", { exact: true }).first()).toBeVisible();

    await files.fill("nested/extra.md");
    await expect(
      section.getByText("Enter filenames only, not paths.", { exact: true }),
    ).toBeVisible();

    await files.fill("Project.local.md\nReview.instructions");
    await expect(
      section.getByText("Enter filenames only, not paths.", { exact: true }),
    ).toHaveCount(0);
    await section.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/contextFiles:\s*\n\s+extra:\s*\n\s+-\s+Project\.local\.md/s);

    await page.reload();
    const reloaded = await openGeneral(page);
    await expect(
      reloaded.section.getByRole("textbox", { name: "Extra Context Files", exact: true }),
    ).toHaveValue("Project.local.md\nReview.instructions");
    expect(realApp.problems).toEqual([]);

    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1909-extra-context-light.png"),
      fullPage: true,
    });

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await dark.setViewportSize({ width: 1280, height: 1500 });
    const darkGeneral = await openGeneral(dark);
    await expect(
      darkGeneral.section.getByRole("textbox", { name: "Extra Context Files", exact: true }),
    ).toHaveValue("Project.local.md\nReview.instructions");
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "fix-1909-extra-context-dark.png"),
      fullPage: true,
    });

    await dark.setViewportSize({ width: 390, height: 844 });
    const dimensions = await dark.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
    const narrowFiles = darkGeneral.section.getByRole("textbox", {
      name: "Extra Context Files",
      exact: true,
    });
    await narrowFiles.scrollIntoViewIfNeeded();
    await expect(narrowFiles).toBeVisible();
    await expect(
      darkGeneral.section.getByText("One entry per line. Blank lines are ignored.").last(),
    ).toBeVisible();
    const controlBounds = await narrowFiles.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth };
    });
    expect(controlBounds.left).toBeGreaterThanOrEqual(0);
    expect(controlBounds.right).toBeLessThanOrEqual(controlBounds.viewport);
    await dark.screenshot({
      path: join(screenshots, "fix-1909-extra-context-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
