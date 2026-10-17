import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots } from "./real-omp";

realTest(
  "shows composer prediction setting in light, dark, and narrow settings",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await mkdir(screenshots, { recursive: true });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Interaction" }).click();
    await dialog.getByRole("button", { name: "This workspace" }).click();
    let predictions = dialog.getByRole("checkbox", { name: "Composer Predictions" });
    await expect(predictions).toBeVisible({ timeout: 20_000 });
    await predictions.scrollIntoViewIfNeeded();
    await expect(predictions).not.toBeChecked();
    await page.screenshot({
      path: join(screenshots, "fix-1919-composer-predictions-light.png"),
      fullPage: true,
    });

    await page.close();
    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await dark.setViewportSize({ width: 1280, height: 900 });
    await dark.getByRole("button", { name: "Settings", exact: true }).click();
    dialog = dark.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Interaction" }).click();
    await dialog.getByRole("button", { name: "This workspace" }).click();
    predictions = dialog.getByRole("checkbox", { name: "Composer Predictions" });
    await expect(predictions).toBeVisible({ timeout: 20_000 });
    await predictions.scrollIntoViewIfNeeded();
    await expect(predictions).not.toBeChecked();
    await dark.screenshot({
      path: join(screenshots, "fix-1919-composer-predictions-dark.png"),
      fullPage: true,
    });

    await dark.setViewportSize({ width: 390, height: 844 });
    await predictions.scrollIntoViewIfNeeded();
    await dark.screenshot({
      path: join(screenshots, "fix-1919-composer-predictions-narrow.png"),
      fullPage: true,
    });
    await predictions.check();
    const save = dialog.getByRole("button", { name: "Save changes" });
    await expect(save).toBeEnabled({ timeout: 20_000 });
    await save.click();
    await expect(dialog.getByText(/Saved for this project/)).toBeVisible({ timeout: 20_000 });
    await expect(save).toBeDisabled({ timeout: 20_000 });
    const config = await readFile(`${realApp.folder}/.omp/config.yml`, "utf8");
    expect(config).toMatch(/composer:\s*\n(?:\s+.*\n)*\s+predictions:\s+true/);
    await dark.reload();
    await dark.getByRole("button", { name: "Settings", exact: true }).click();
    dialog = dark.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("button", { name: "Interaction" }).click();
    await dialog.getByRole("button", { name: "This workspace" }).click();
    predictions = dialog.getByRole("checkbox", { name: "Composer Predictions" });
    await expect(predictions).toBeChecked({ timeout: 20_000 });
    expect(realApp.problems).toEqual([]);
  },
);
