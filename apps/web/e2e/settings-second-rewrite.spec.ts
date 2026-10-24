import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/** Writes the settings file the way omp does: a temporary file, renamed over the target. */
async function writeSettingsFile(agentDir: string, content: string): Promise<void> {
  const target = join(agentDir, "config.yml");
  await writeFile(`${target}.tmp`, content);
  await rename(`${target}.tmp`, target);
}

/**
 * Rewrites the settings file in a loop, with a comment that changes no value, until stopped. Each save
 * attempt then finds a revision it did not read, so a retry meets a second outside rewrite.
 */
function rewriteUntilStopped(
  agentDir: string,
  base: string,
): { readonly stop: () => Promise<void> } {
  let stopped = false;
  const rewrites = (async () => {
    for (let count = 1; !stopped; count += 1) {
      await writeSettingsFile(agentDir, `# outside rewrite ${count}\n${base}`);
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await rewrites;
    },
  };
}

async function openImages(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("tab", { name: "Images", exact: true }).click();
  const section = page.locator('[data-s1-appearance-section="S1.appearanceImages"]');
  await expect(section).toBeVisible();
  return section;
}

realTest(
  "a second outside rewrite during the retried save keeps the edit and says why nothing was written",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const base = "terminal:\n  showImages: false\n";
    await writeSettingsFile(realApp.agentDir, base);
    const section = await openImages(page);
    const autoResize = section.getByRole("checkbox", { name: "Auto-Resize Images" });
    const wasChecked = await autoResize.isChecked();
    await autoResize.click();

    const rewrites = rewriteUntilStopped(realApp.agentDir, base);
    try {
      await section.getByRole("button", { name: "Save changes" }).click();
      // Both attempts meet an outside rewrite: nothing is written, the edit stays, and the notice names
      // the setting and the reason. Before the fix the save looked like it did nothing.
      await expect(section.getByText("Not saved: Auto-Resize Images.")).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        section.getByText("Settings changed elsewhere while this save ran", { exact: false }),
      ).toBeVisible();
      await section
        .getByText("Settings changed elsewhere while this save ran", { exact: false })
        .scrollIntoViewIfNeeded();
      await waitForFiniteAnimations(page);
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({
        path: join(screenshots, "settings-second-rewrite-notice.png"),
        fullPage: true,
      });
      await expect(autoResize).toBeChecked({ checked: !wasChecked });
      await expect(section.getByRole("button", { name: "Save changes" })).toBeEnabled();
    } finally {
      await rewrites.stop();
    }

    // With omp no longer rewriting, the same edit saves.
    await section.getByRole("button", { name: "Save changes" }).click();
    await expect(section.getByRole("button", { name: "Save changes" })).toBeDisabled({
      timeout: 30_000,
    });
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"))
      .toContain(`autoResize: ${String(!wasChecked)}`);
    expect(realApp.problems).toEqual([]);
  },
);
