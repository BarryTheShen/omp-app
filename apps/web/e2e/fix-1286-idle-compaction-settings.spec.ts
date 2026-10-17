import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const HIDDEN_SETTINGS = [
  "Branch Summaries",
  "Idle Compaction",
  "Idle Compaction Threshold",
  "Idle Compaction Delay",
] as const;

async function openContext(
  page: Page,
): Promise<{ readonly settings: Locator; readonly context: Locator }> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Context", exact: true }).click();
  const context = settings.locator("[data-p7-context-settings]");
  await expect(context).toBeVisible();
  return { settings, context };
}

async function expectUnsupportedHidden(context: Locator): Promise<void> {
  for (const label of HIDDEN_SETTINGS) {
    await expect(context.getByText(label, { exact: true })).toHaveCount(0);
  }
}

async function expectStyled(page: Page, theme: "light" | "dark"): Promise<void> {
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

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

realTest(
  "Context settings hide branch summaries and idle compaction controls",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const { context } = await openContext(page);

    await expectUnsupportedHidden(context);
    await expect(context.getByRole("tab", { name: "General", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(context.getByRole("checkbox", { name: "Extended Context" })).toBeVisible();
    await expectStyled(page, "light");
    await capture(page, "fix-1286-context-general-light.png");

    await context.getByRole("tab", { name: "Compaction", exact: true }).click();
    await expectUnsupportedHidden(context);
    await expect(context.getByRole("checkbox", { name: "Auto-Compact" })).toBeVisible();
    await capture(page, "fix-1286-context-compaction-light.png");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Context settings without idle controls remain styled in dark and at 390 px",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const { context, settings } = await openContext(page);
    await context.getByRole("tab", { name: "Compaction", exact: true }).click();
    await expectUnsupportedHidden(context);
    await expect(context.getByRole("checkbox", { name: "Auto-Compact" })).toBeVisible();
    await expectStyled(page, "dark");
    await capture(page, "fix-1286-context-compaction-dark.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await expectUnsupportedHidden(context);
    const box = await settings.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await expectStyled(page, "dark");
    await capture(page, "fix-1286-context-compaction-narrow.png");
    expect(realApp.problems).toEqual([]);
  },
);
