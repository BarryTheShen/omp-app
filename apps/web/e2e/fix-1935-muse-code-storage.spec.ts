import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

async function openMuseCodeSettings(page: Page): Promise<{ dialog: Locator; control: Locator }> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("button", { name: "Providers", exact: true }).click();
  const protocol = dialog.getByRole("option", { name: "Protocol", exact: true });
  await expect(protocol).toBeVisible({ timeout: 20_000 });
  await protocol.click();
  const control = dialog.getByRole("checkbox", {
    name: "Muse Code stored responses",
    exact: true,
  });
  await expect(control).toBeVisible({ timeout: 20_000 });
  return { dialog, control };
}

realTest(
  "Muse Code response storage appears in app Settings, saves through omp, and survives reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await startChat(page);

    let { dialog, control } = await openMuseCodeSettings(page);
    await expect(control).not.toBeChecked();
    await expect(
      dialog.getByText("When using Muse Code, store responses on Meta's servers", { exact: false }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "All workspaces", exact: true }).click();
    await control.check();
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/providers:\s*\n\s+muse-code:\s*\n\s+storeResponses:\s*true/m);

    await page.reload();
    ({ dialog, control } = await openMuseCodeSettings(page));
    await expect(control).toBeChecked({ timeout: 20_000 });
    await control.scrollIntoViewIfNeeded();
    await expect(dialog).toHaveCSS("background-color", /^(rgb|oklch)/);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1935-muse-code-storage-light.png"),
      fullPage: true,
    });

    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    ({ dialog, control } = await openMuseCodeSettings(page));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(control).toBeChecked();
    await control.scrollIntoViewIfNeeded();
    await expect(dialog).toHaveCSS("background-color", /^(rgb|oklch)/);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1935-muse-code-storage-dark.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1935-muse-code-storage-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
