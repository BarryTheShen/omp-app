import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/*
 * S2.4: the six Files and Shell settings sections render inside the settings screen (S1.3), each through its S1.1
 * section body, in the real app. Files lists Editing, Reading, Read Summaries and LSP; Shell lists Bash and Eval and
 * Runtimes; search finds Eval and Runtimes by omp's own spelling of its group, "eval & runtimes".
 */

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
}

realTest(
  "the Files and Shell tabs list the six S2 sections, and Editing shows omp's edit modes in plain words",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await openSettings(page);
    const settings = page.getByTestId("settings-screen");

    await settings.getByRole("button", { name: "Files", exact: true }).click();
    const files = page.getByRole("listbox", { name: "Files settings sections" });
    for (const name of ["Editing", "Reading", "Read Summaries", "LSP"]) {
      await expect(files.getByRole("option", { name, exact: true })).toBeVisible();
    }
    await files.getByRole("option", { name: "Editing", exact: true }).click();
    const editMode = settings.getByRole("combobox", { name: "Edit Mode" });
    await expect(editMode).toHaveValue("hashline");
    await expect(editMode.getByRole("option")).toHaveText([
      "Apply patch",
      "Hashline",
      "Patch",
      "Replace",
      "Sloppy",
    ]);
    await editMode.scrollIntoViewIfNeeded();
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "s2-4-settings-light.png"), fullPage: true });

    await settings.getByRole("button", { name: "Shell", exact: true }).click();
    const shell = page.getByRole("listbox", { name: "Shell settings sections" });
    await expect(shell.getByRole("option", { name: "Bash", exact: true })).toBeVisible();
    await expect(
      shell.getByRole("option", { name: "Eval and Runtimes", exact: true }),
    ).toBeVisible();

    await settings.getByLabel("Search sections").fill("eval & runtimes");
    await expect(
      shell.getByRole("option", { name: "Eval and Runtimes", exact: true }),
    ).toBeVisible();
    await expect(shell.getByRole("option", { name: "Bash", exact: true })).toHaveCount(0);
    await shell.getByRole("option", { name: "Eval and Runtimes", exact: true }).click();
    await expect(settings.getByRole("combobox", { name: "Python Kernel Mode" })).toHaveValue(
      "session",
    );
  },
);

realTest("the Files sections read in dark and at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
  await page.reload();
  await openSettings(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  const settings = page.getByTestId("settings-screen");

  await settings.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("option", { name: "Editing", exact: true }).click();
  const editMode = settings.getByRole("combobox", { name: "Edit Mode" });
  await expect(editMode).toBeVisible();
  await editMode.scrollIntoViewIfNeeded();
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "s2-4-settings-dark.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(settings.getByRole("combobox", { name: "Edit Mode" })).toBeVisible();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "s2-4-settings-narrow.png"), fullPage: true });
});
