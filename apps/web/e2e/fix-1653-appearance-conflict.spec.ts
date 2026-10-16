import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const CONFLICT = "Settings changed elsewhere";
const CONFLICT_DESCRIPTION =
  "Another change arrived while this section was open. Reload the latest values or keep your edits and save again.";

async function reachAppearanceConflict(
  page: Page,
  agentDir: string,
  outsideValue: string,
): Promise<{ readonly section: Locator; readonly conflict: Locator }> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  await settings
    .getByRole("tablist", { name: "Appearance sections" })
    .getByRole("tab", { name: "Composer", exact: true })
    .click();

  const section = page.locator('[data-s1-appearance-section="S1.appearanceComposer"]');
  const shape = section.getByRole("textbox", { name: "Composer Shape", exact: true });
  await expect(shape).toBeVisible();
  await shape.fill("Mine");
  const save = section.getByRole("button", { name: "Save changes", exact: true });
  await writeSettingsFile(agentDir, `composer:\n  shape: "${outsideValue}"\n`);

  const conflict = section.getByRole("alert");
  const conflictHeading = section.getByRole("heading", { name: CONFLICT, exact: true });
  await expect
    .poll(async () => (await conflict.count()) > 0 || (await save.isEnabled()))
    .toBe(true);
  if (await save.isEnabled()) {
    await save.evaluate((button) => (button as HTMLButtonElement).click());
  }
  await expect(conflictHeading).toBeVisible({ timeout: 15_000 });
  await expect(conflict).toContainText(CONFLICT_DESCRIPTION);
  await expect(section.getByText(CONFLICT, { exact: true })).toHaveCount(1);
  await expect(shape).toBeDisabled();
  await expect(save).toBeDisabled();
  await expect(conflict.getByRole("button", { name: "Reload latest", exact: true })).toBeEnabled();
  await expect(conflict.getByRole("button", { name: "Keep my edits", exact: true })).toBeEnabled();
  return { section, conflict };
}

async function writeSettingsFile(agentDir: string, content: string): Promise<void> {
  const target = join(agentDir, "config.yml");
  await writeFile(`${target}.tmp`, content);
  await rename(`${target}.tmp`, target);
}

async function expectStyledSettings(page: Page, theme: "light" | "dark"): Promise<void> {
  const settings = page.getByTestId("settings-screen");
  const colors = await settings.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--sidebar)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  expect(colors.token).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.actual).toBe(colors.token);
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
}

async function capture(page: Page, name: string, conflict: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await conflict.scrollIntoViewIfNeeded();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

realTest(
  "Appearance conflicts use the shared heading, description, and actions in light, dark, and narrow layouts",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const light = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await light.setViewportSize({ width: 1280, height: 1000 });
    const { conflict: lightConflict } = await reachAppearanceConflict(
      light,
      realApp.agentDir,
      "outside-light",
    );
    await expectStyledSettings(light, "light");
    await capture(light, "fix-1653-appearance-conflict-light.png", lightConflict);

    await light.setViewportSize({ width: 390, height: 844 });
    await expect(light.getByRole("button", { name: "Keep my edits", exact: true })).toBeVisible();
    expect(await light.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await capture(light, "fix-1653-appearance-conflict-narrow.png", lightConflict);
    await light.close();

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await dark.setViewportSize({ width: 1280, height: 1000 });
    const { conflict: darkConflict } = await reachAppearanceConflict(
      dark,
      realApp.agentDir,
      "outside-dark",
    );
    await expectStyledSettings(dark, "dark");
    await capture(dark, "fix-1653-appearance-conflict-dark.png", darkConflict);
    expect(realApp.problems).toEqual([]);
  },
);
