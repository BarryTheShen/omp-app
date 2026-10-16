import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

realTest.use({ serverEnv: { PI_NO_THINKING_LOOP_GUARD: "1" } });
realTest.setTimeout(240_000);

const NOTICE =
  "Saved, but omp still uses the environment variable PI_NO_THINKING_LOOP_GUARD until it is removed.";

async function openThinking(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Model", exact: true }).click();
  await dialog.getByRole("option", { name: "Thinking", exact: true }).click();
  const panel = dialog.getByRole("region", { name: "Model settings", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

async function saveLoopGuard(page: Page): Promise<Locator> {
  const panel = await openThinking(page);
  const loopGuard = panel.getByRole("checkbox", { name: "Loop Guard", exact: true });
  await expect(loopGuard).not.toBeChecked();
  await loopGuard.check();
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.click();
  await expect(save).toBeDisabled({ timeout: 20_000 });
  const notice = panel.getByText(NOTICE, { exact: true });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(loopGuard).not.toBeChecked();
  await expect(panel.getByText("Applied", { exact: true })).toHaveCount(0);
  return notice;
}

async function capture(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await anchor.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name) });
}

realTest("the Model tab names its inverted environment override in light", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
  });
  const notice = await saveLoopGuard(page);
  await capture(page, "fix-1430-model-env-light.png", notice);
  expect(realApp.problems).toEqual([]);
});

realTest("the Model tab names its inverted environment override in dark", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const notice = await saveLoopGuard(page);
  await capture(page, "fix-1430-model-env-dark.png", notice);
  expect(realApp.problems).toEqual([]);
});

realTest("the Model tab environment notice fits at 390 px", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const notice = await saveLoopGuard(page);
  const settingsBox = await page.getByTestId("settings-screen").boundingBox();
  expect((settingsBox?.x ?? 0) + (settingsBox?.width ?? 0)).toBeLessThanOrEqual(390);
  await capture(page, "fix-1430-model-env-narrow.png", notice);
  expect(realApp.problems).toEqual([]);
});
