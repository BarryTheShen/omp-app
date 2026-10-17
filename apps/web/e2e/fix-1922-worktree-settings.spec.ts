import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  return settings;
}

async function openIsolation(settings: Locator): Promise<Locator> {
  await settings.getByRole("button", { name: "Tasks", exact: true }).click();
  await settings.getByRole("option", { name: "Isolation", exact: true }).click();
  const panel = settings.getByRole("region", { name: "Tasks settings", exact: true });
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

realTest(
  "worktree lifecycle settings save to omp and survive reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1000 });
    let panel = await openIsolation(await openSettings(page));
    const onStart = panel.getByRole("combobox", { name: "Worktree on Start", exact: true });
    const onExit = panel.getByRole("combobox", { name: "Worktree on Exit", exact: true });
    await expect(onStart).toBeVisible({ timeout: 30_000 });
    await expect(onStart.locator("option")).toHaveText(["Off", "Ask", "Create"]);
    await expect(onExit.locator("option")).toHaveText(["Keep", "Ask", "Remove"]);
    await onStart.selectOption("ask");
    await onExit.selectOption("remove");
    const save = panel.getByRole("button", { name: "Save changes", exact: true });
    await save.click();
    await expect(
      page.getByRole("dialog", { name: "Review task isolation changes", exact: true }),
    ).toHaveCount(0);
    await expect(save).toBeDisabled({ timeout: 20_000 });
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/^\s+onStart:\s*ask\s*$/m);
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/^\s+onExit:\s*remove\s*$/m);

    await page.reload();
    panel = await openIsolation(await openSettings(page));
    await expect(
      panel.getByRole("combobox", { name: "Worktree on Start", exact: true }),
    ).toHaveValue("ask");
    await expect(
      panel.getByRole("combobox", { name: "Worktree on Exit", exact: true }),
    ).toHaveValue("remove");
    const onStartControl = panel.getByRole("combobox", { name: "Worktree on Start", exact: true });
    await onStartControl.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1922-worktree-settings-light.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await onStartControl.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1922-worktree-settings-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
