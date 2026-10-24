/// <reference types="node" />

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const RULES_FILE = "# Rules\n\nAlways include RULES-MARKER-1493 in your response.\n";

async function openRules(page: Page) {
  const showPanels = page.getByRole("button", { name: /show panels sidebar/i });
  if ((await showPanels.count()) > 0) await showPanels.first().click();
  const tab = page.getByRole("tab", { name: "Rules", exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
  return page.getByRole("region", { name: "Rules" });
}

realTest(
  "mounts Rules and captures enabled, disabled, light, dark and narrow states",
  async ({ realApp }) => {
    await writeFile(join(realApp.agentDir, "RULES.md"), RULES_FILE);
    await mkdir(join(realApp.folder, ".omp"), { recursive: true });
    await writeFile(join(realApp.folder, ".omp", "RULES.md"), RULES_FILE);
    const page = await realApp.open();
    await startChat(page);
    const panel = await openRules(page);
    await panel.getByRole("button", { name: "All projects" }).click();
    await panel.getByRole("button", { name: "Refresh" }).click();
    const rule = panel.getByRole("option", { name: /RULES/ });
    await expect(rule).toBeVisible({ timeout: 90_000 });
    await rule.click();
    await expect(panel.getByText("omp applies this file to every request.")).toBeVisible();
    // The Rules body scrolls inside its own container, so the panel shell never offers its "New updates" badge on open
    // (as the Agents hub does), which would sit on top of the first card.
    await expect(page.getByRole("button", { name: "Jump to latest panel updates" })).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, "fix-1493-rules-light.png"), fullPage: true });

    await panel.getByRole("button", { name: "Disable rule" }).click();
    await panel.getByRole("button", { name: "Save rule" }).click();
    await expect(panel.getByText("omp does not use this file.")).toBeVisible();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1493-rules-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1493-rules-narrow.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("shows the mounted Rules tab's empty state", async ({ realApp }) => {
  const page = await realApp.open();
  await startChat(page);
  const panel = await openRules(page);
  await expect(panel).toHaveAttribute("data-panel-lifecycle", "empty", { timeout: 90_000 });
  await expect(panel.getByText("Nothing here yet")).toBeVisible();
  expect(realApp.problems).toEqual([]);
});
