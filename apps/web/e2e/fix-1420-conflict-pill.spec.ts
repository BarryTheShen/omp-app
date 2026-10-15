import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1420 on real omp. A setting changed outside the app while an edit is staged puts the section in conflict.
 * The conflict card says "Settings changed elsewhere" with Reload latest and Keep my edits; the section header must
 * not repeat those words in a status pill above it.
 */

const CONFLICT = "Settings changed elsewhere";

/** Writes the settings file the way omp does: a temporary file, renamed over the target. */
async function writeSettingsFile(agentDir: string, content: string): Promise<void> {
  const target = join(agentDir, "config.yml");
  await writeFile(`${target}.tmp`, content);
  await rename(`${target}.tmp`, target);
}

realTest(
  "a settings conflict says its heading once: in the conflict card, with no status pill above it",
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
    await expect(displayName).toBeVisible({ timeout: 30_000 });
    await displayName.fill("Mine");
    await expect(displayName).toHaveValue("Mine");

    await writeSettingsFile(realApp.agentDir, "collab:\n  displayName: Theirs\n");
    const conflictHeading = settings.getByRole("heading", { name: CONFLICT, exact: true });
    await expect(conflictHeading).toBeVisible({ timeout: 10_000 });
    await expect(
      settings.getByRole("button", { name: "Keep my edits", exact: true }),
    ).toBeVisible();
    await expect(settings.getByText(CONFLICT, { exact: true })).toHaveCount(1);

    await conflictHeading.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1420-conflict-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1420-conflict-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await conflictHeading.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await expect(settings.getByText(CONFLICT, { exact: true })).toHaveCount(1);
    await page.screenshot({ path: join(screenshots, "fix-1420-conflict-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
