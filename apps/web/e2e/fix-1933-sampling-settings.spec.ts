import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function openSampling(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByRole("button", { name: "Model", exact: true }).click();
  await page
    .getByRole("listbox", { name: "Model settings sections" })
    .getByRole("option", {
      name: "Sampling",
      exact: true,
    })
    .click();
  await expect(page.getByRole("heading", { name: "Sampling", exact: true })).toBeVisible();
}
realTest(
  "D1 Model Sampling exposes omp's settings and saves a value to config.yml",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 2200 });
    await openSampling(page);

    for (const label of [
      "Temperature",
      "Top P",
      "Top K",
      "Min P",
      "Presence Penalty",
      "Repetition Penalty",
      "Text Verbosity",
      "Service Tier — Advisor",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("spinbutton", { name: "Top P", exact: true })).toHaveValue("-1");
    await expect(page.getByRole("combobox", { name: "Text Verbosity", exact: true })).toHaveValue(
      "medium",
    );

    await page.getByRole("spinbutton", { name: "Top P", exact: true }).fill("0.9");
    await page
      .getByRole("combobox", { name: "Service Tier — Advisor", exact: true })
      .selectOption("flex");
    const save = page.getByRole("button", { name: "Save changes", exact: true });
    await save.click();
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/^topP:\s*0\.9\s*$/m);
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/tier:\s*\n\s+advisor:\s*flex\s*$/m);
    await expect(page.getByRole("spinbutton", { name: "Top P", exact: true })).toHaveValue("0.9");
    await expect(
      page.getByRole("combobox", { name: "Service Tier — Advisor", exact: true }),
    ).toHaveValue("flex");
    expect(realApp.problems).toEqual([]);

    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1933-sampling-light.png"),
      fullPage: true,
    });

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await dark.setViewportSize({ width: 1280, height: 2200 });
    await openSampling(dark);
    await expect(dark.getByRole("spinbutton", { name: "Top P", exact: true })).toHaveValue("0.9");
    await expect(
      dark.getByRole("combobox", { name: "Service Tier — Advisor", exact: true }),
    ).toHaveValue("flex");
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "fix-1933-sampling-dark.png"),
      fullPage: true,
    });

    await dark.setViewportSize({ width: 390, height: 2200 });
    await expect(dark.getByText("Service Tier — Advisor", { exact: true })).toBeVisible();
    const dimensions = await dark.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
    await dark.screenshot({
      path: join(screenshots, "fix-1933-sampling-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
