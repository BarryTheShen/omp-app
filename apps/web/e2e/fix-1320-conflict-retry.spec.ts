import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1320. A setting changed outside the app while an edit is staged shows "Settings changed elsewhere" with
 * "Reload latest" and "Keep my edits" only: no Retry beside them. Retry re-reads omp's values and would drop the edit.
 * This stages a Display Name (Interaction, Collab), has omp's settings file change it to another value, and then
 * keeps the edit and saves it: the saved value must be the person's, not the outside one. The refused-save path (the
 * issue's own sequence) races omp's 100 ms file watcher, so the unit tests in settings-screen.test.tsx cover it.
 */

/** Writes the settings file the way omp does: a temporary file, renamed over the target. */
async function writeSettingsFile(agentDir: string, content: string): Promise<void> {
  const target = join(agentDir, "config.yml");
  await writeFile(`${target}.tmp`, content);
  await rename(`${target}.tmp`, target);
}

realTest(
  "a setting changed elsewhere while it is edited offers only Reload latest and Keep my edits, and Keep my edits saves",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByTestId("settings-screen");
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "Interaction", exact: true }).click();
    await page.getByRole("option", { name: "Collab", exact: true }).click();

    const displayName = settings.getByRole("textbox", { name: "Display Name", exact: true });
    // On a loaded machine omp's first settings read can hit the app's own read timeout. The app then shows that alert
    // with a Retry, which is what a person presses; this test is about the conflict that follows, not read latency.
    const readTimeout = settings
      .getByRole("alert")
      .filter({ hasText: "Settings took too long to load." });
    await expect
      .poll(async () => (await displayName.isVisible()) || (await readTimeout.isVisible()), {
        timeout: 30_000,
      })
      .toBe(true);
    if (await readTimeout.isVisible()) {
      await readTimeout.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(displayName).toBeVisible({ timeout: 30_000 });
    }
    await displayName.fill("Mine");
    await expect(displayName).toHaveValue("Mine");
    const save = settings.getByRole("button", { name: "Save changes", exact: true });
    const conflictHeading = settings.getByRole("heading", {
      name: "Settings changed elsewhere",
      exact: true,
    });

    // omp's settings file changes the same setting to another value while the edit is staged.
    await writeSettingsFile(realApp.agentDir, "collab:\n  displayName: Theirs\n");
    await expect(conflictHeading).toBeVisible({ timeout: 10_000 });
    await expect(
      settings.getByRole("button", { name: "Reload latest", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "Keep my edits", exact: true }),
    ).toBeVisible();
    await expect(settings.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("alert")).toHaveCount(1);
    await expect(settings.getByRole("alert")).toContainText("Settings changed elsewhere");
    await expect(displayName).toHaveValue("Mine");
    // Centres the conflict card in the dialog's scroll area, so the captures show the two choices with the field.
    await conflictHeading.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1320-conflict-light.png") });

    await page.emulateMedia({ colorScheme: "dark" });
    await conflictHeading.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1320-conflict-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await conflictHeading.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1320-conflict-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    await settings.getByRole("button", { name: "Keep my edits", exact: true }).click();
    await expect(conflictHeading).toHaveCount(0);
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await expect(displayName).toHaveValue("Mine");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeDisabled({ timeout: 20_000 });
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"))
      .toContain("displayName: Mine");
    expect(await readFile(join(realApp.agentDir, "config.yml"), "utf8")).not.toContain("Theirs");
    expect(realApp.problems).toEqual([]);
  },
);
