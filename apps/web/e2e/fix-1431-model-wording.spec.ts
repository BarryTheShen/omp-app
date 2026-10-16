import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1431 on real omp. The Model tab's Thinking section, in conflict, names its two choices the way every other
 * settings tab does: Reload latest and Keep my edits. The Model tab said Reload and Keep mine.
 */

const CONFLICT = "Settings changed elsewhere";

async function openModelThinking(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Model", exact: true }).click();
  const section = page.getByTestId("model-settings-thinking");
  await expect(section).toBeVisible({ timeout: 30_000 });
  return section;
}

// Stages a Thinking Level change, then has another writer set the same setting: the section holds a conflict.
async function reachConflict(page: Page, agentDir: string): Promise<Locator> {
  const section = await openModelThinking(page);
  const level = section.getByRole("combobox", { name: "Thinking Level", exact: true });
  await expect(level).toBeEnabled({ timeout: 20_000 });
  await level.selectOption("high");
  await writeFile(join(agentDir, "config.yml"), "defaultThinkingLevel: minimal\n");
  // A click on a disabled Save does nothing, so the click needs no wait; the conflict shows either way.
  await section
    .getByRole("button", { name: "Save changes", exact: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(section.getByRole("alert").filter({ hasText: CONFLICT })).toBeVisible({
    timeout: 15_000,
  });
  return section;
}

realTest(
  "the Model tab's conflict offers Reload latest and Keep my edits, the words the other tabs use",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1100 });
    const section = await reachConflict(page, realApp.agentDir);
    await expect(section.getByRole("heading", { name: CONFLICT, exact: true })).toHaveCount(1);
    await expect(
      section.getByText(
        "Another change arrived while this section was open. Reload the latest values or keep your edits and save again.",
        { exact: true },
      ),
    ).toHaveCount(1);
    const conflict = section.getByRole("alert").filter({ hasText: CONFLICT });
    await expect(
      conflict.getByRole("button", { name: "Reload latest", exact: true }),
    ).toBeEnabled();
    await expect(
      conflict.getByRole("button", { name: "Keep my edits", exact: true }),
    ).toBeEnabled();
    await expect(conflict.getByRole("button", { name: "Reload", exact: true })).toHaveCount(0);
    await expect(conflict.getByRole("button", { name: "Keep mine", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await mkdir(screenshots, { recursive: true });
    await conflict.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1431-model-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1431-model-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await conflict.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await expect(
      conflict.getByRole("button", { name: "Keep my edits", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-1431-model-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
