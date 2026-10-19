import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * The settings screen saves what the person changes. "All workspaces" writes omp's global settings
 * and "This workspace" the open folder's: the config store refuses a global write that names a
 * folder, so the screen once showed "Invalid port arguments" on every save and kept nothing.
 * This opens the screen on real omp, changes one setting in each place, saves it, and reads it again
 * after a reload.
 */

async function openInteraction(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Interaction" }).click();
  return dialog;
}

realTest(
  "a setting saved for all workspaces and one for this workspace are kept",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const configPath = join(realApp.agentDir, "config.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(configPath, `${config}\nsteeringMode: one-at-a-time\n`, "utf8");
    await realApp.restartServer();
    const page = await realApp.open();

    // All workspaces. Controls carry the setting's name, so a screen reader hears what each one is.
    let dialog = await openInteraction(page);
    const steering = dialog.getByRole("combobox", { name: "Steering Mode" });
    await expect(steering).toHaveValue("one-at-a-time");
    await steering.selectOption("all");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByRole("button", { name: "Save changes" })).toBeDisabled({
      timeout: 20_000,
    });
    await expect(dialog.getByText("Invalid port arguments")).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, "app-settings-save", "saved-global.png") });

    // This workspace.
    await dialog.getByRole("button", { name: "This workspace" }).click();
    const followUp = dialog.getByRole("combobox", { name: "Follow-Up Mode" });
    await expect(followUp).toBeVisible({ timeout: 20_000 });
    await followUp.selectOption("all");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByRole("button", { name: "Save changes" })).toBeDisabled({
      timeout: 20_000,
    });
    await expect(dialog.getByText("Invalid port arguments")).toHaveCount(0);

    // After a reload both are still there.
    await page.reload();
    dialog = await openInteraction(page);
    await expect(dialog.getByRole("combobox", { name: "Steering Mode" })).toHaveValue("all", {
      timeout: 20_000,
    });
    await dialog.getByRole("button", { name: "This workspace" }).click();
    await expect(dialog.getByRole("combobox", { name: "Follow-Up Mode" })).toHaveValue("all", {
      timeout: 20_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);
