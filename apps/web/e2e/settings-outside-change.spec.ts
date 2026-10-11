import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function openImages(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByRole("tab", { name: "Images", exact: true }).click();
  const section = page.locator('[data-s1-appearance-section="S1.appearanceImages"]');
  await expect(section).toBeVisible();
  return section;
}

/** Writes the settings file the way omp does: a temporary file, renamed over the target. */
async function writeSettingsFile(agentDir: string, content: string): Promise<void> {
  const target = join(agentDir, "config.yml");
  await writeFile(`${target}.tmp`, content);
  await rename(`${target}.tmp`, target);
}

realTest(
  "a change made outside the app shows in an open settings section, and a rewrite that changes no value is not a conflict",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const section = await openImages(page);
    const showImages = section.getByRole("checkbox", { name: "Show Inline Images" });
    const autoResize = section.getByRole("checkbox", { name: "Auto-Resize Images" });
    const showBefore = await showImages.isChecked();

    // omp's terminal changes a setting: the open section shows the new value within five seconds.
    await writeSettingsFile(realApp.agentDir, `terminal:\n  showImages: ${String(!showBefore)}\n`);
    await expect(showImages).toBeChecked({ checked: !showBefore, timeout: 5_000 });
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: join(screenshots, "settings-outside-change-light.png"),
      fullPage: true,
    });

    // omp rewrites the file with the same values (a comment is added). No value changed, so the
    // next save writes the setting without reporting a conflict.
    await writeSettingsFile(
      realApp.agentDir,
      `# Edited outside the app.\nterminal:\n  showImages: ${String(!showBefore)}\n`,
    );
    await autoResize.click();
    await section.getByRole("button", { name: "Save changes" }).click();
    await expect(section.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await expect(page.getByText("Another settings writer changed")).toHaveCount(0);
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"))
      .toContain("autoResize: false");

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "settings-outside-change-narrow.png"),
      fullPage: true,
    });

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const darkSection = await openImages(dark);
    const darkShow = darkSection.getByRole("checkbox", { name: "Show Inline Images" });
    const darkBefore = await darkShow.isChecked();
    await writeSettingsFile(
      realApp.agentDir,
      `images:\n  autoResize: false\nterminal:\n  showImages: ${String(!darkBefore)}\n`,
    );
    await expect(darkShow).toBeChecked({ checked: !darkBefore, timeout: 5_000 });
    await waitForFiniteAnimations(dark);
    await dark.screenshot({
      path: join(screenshots, "settings-outside-change-dark.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
