/// <reference types="node" />

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #2648. Three groups of omp's settings were built in the app but shown on no screen: the Memory tab (I3), the
 * Interaction tab's Stream section (I4) and the Model tab's Advisor section (P1). On real omp each test opens the group
 * in Settings, changes a control, saves, and checks that omp's own config.yml got the value in the shape omp reads,
 * then captures the section in light, in dark and at 390 px.
 */

/** omp's config.yml in this run's agent folder, read until `pattern` matches (a save is written in the background). */
async function expectConfig(
  realApp: { readonly agentDir: string },
  pattern: RegExp,
): Promise<void> {
  await expect
    .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
    .toMatch(pattern);
}

/** A group's key in omp's nested config.yml, then a later indented line for `key: value`. */
function nested(group: string, key: string, value: string): RegExp {
  return new RegExp(`^${group}:\\s*\\n(?:[ \\t]+[^\\n]+\\n)*[ \\t]+${key}:\\s*${value}`, "m");
}

/** Captures what `anchor` shows in light, in dark and at 390 px (no sideways scrolling), then restores the page. */
async function shoot(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  const wide = page.viewportSize() ?? { width: 1280, height: 1000 };
  const capture = async (mode: "light" | "dark" | "390"): Promise<void> => {
    await anchor.first().evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, `fix-2648-${name}-${mode}.png`) });
  };
  await capture("light");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(page.locator("html")).toHaveClass(/dark/);
  await capture("dark");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(anchor.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await capture("390");
  await page.setViewportSize(wide);
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  return settings;
}

/** Selects one section of a tab and returns the panel that holds its controls. */
async function openSection(settings: Locator, tab: string, title: string): Promise<Locator> {
  await settings.getByRole("button", { name: tab, exact: true }).click();
  await settings.getByRole("option", { name: title, exact: true }).click();
  const panel = settings.getByRole("region", { name: `${tab} settings`, exact: true });
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole("heading", { name: title, exact: true })).toBeVisible();
  return panel;
}

/** Saves a section and waits until the save is done and the section says the change applied. */
async function save(panel: Locator): Promise<void> {
  const button = panel.getByRole("button", { name: "Save changes", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeDisabled({ timeout: 20_000 });
}

realTest.setTimeout(300_000);

realTest(
  "the Memory tab lists omp's memory sections, and Auto-Learn saves to omp's config",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1000 });
    const settings = await openSettings(page);
    await settings.getByRole("button", { name: "Memory", exact: true }).click();
    const list = settings.getByRole("listbox", { name: "Memory settings sections", exact: true });
    await expect(list.getByRole("option")).toHaveText(
      ["General", "Auto-Learn", "Mnemopi", "Hindsight", "Sharpshooter"],
      { timeout: 30_000 },
    );

    const autoLearn = await openSection(settings, "Memory", "Auto-Learn");
    const enabled = autoLearn.getByRole("checkbox", {
      name: "Auto-Learn (experimental)",
      exact: true,
    });
    await expect(enabled).not.toBeChecked({ timeout: 30_000 });
    await enabled.check();
    await save(autoLearn);
    await expectConfig(realApp, nested("autolearn", "enabled", "true"));
    await shoot(page, "memory", enabled);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Interaction > Stream saves its server and keeps the redaction patterns as the strings omp reads",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1000 });
    const settings = await openSettings(page);
    const stream = await openSection(settings, "Interaction", "Stream");
    const server = stream.getByRole("textbox", { name: "Stream Server", exact: true });
    await expect(server).toBeVisible({ timeout: 30_000 });
    await server.fill("https://stream.example.com");
    await stream.getByRole("button", { name: "Add pattern", exact: true }).click();
    const pattern = stream.getByRole("textbox", { name: /Regular expression/ }).last();
    await pattern.fill("sk-[a-z0-9]{20}");
    await save(stream);
    await expectConfig(
      realApp,
      nested("stream", "serverUrl", `["']?https://stream\\.example\\.com["']?`),
    );
    // A list of strings, as omp stores it (`stream/settings.ts`), not the { pattern } rows the editor shows.
    await expectConfig(realApp, /redactPatterns:\s*\n\s+- ["']?sk-\[a-z0-9\]\{20\}["']?\s*$/m);
    await shoot(page, "stream", server);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Model > Advisor shows omp's eight advisor settings and saves them in omp's types",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1000 });
    const settings = await openSettings(page);
    const advisor = await openSection(settings, "Model", "Advisor");
    const enable = advisor.getByRole("checkbox", { name: "Enable Advisor", exact: true });
    await expect(enable).toBeVisible({ timeout: 30_000 });
    for (const label of [
      "Advisor Sync Backlog",
      "Advisor Immune Turns",
      "Advisor Continue Severity",
      "Advisor Review Mode",
    ]) {
      await expect(advisor.getByRole("combobox", { name: label, exact: true })).toBeVisible();
    }
    for (const label of ["Advisor Review Interval", "Advisor Max Notes Per Update"]) {
      await expect(advisor.getByRole("spinbutton", { name: label, exact: true })).toBeVisible();
    }
    await expect(
      advisor.getByRole("checkbox", { name: "Advisor Evict Stale Results", exact: true }),
    ).toBeVisible();

    await enable.check();
    await advisor
      .getByRole("combobox", { name: "Advisor Immune Turns", exact: true })
      .selectOption({
        label: "5 turns",
      });
    await save(advisor);
    await expectConfig(realApp, nested("advisor", "enabled", "true"));
    // A number, as omp declares it (`advisor/settings.ts`, `type: "number"`), not the text "5".
    await expectConfig(realApp, nested("advisor", "immuneTurns", "5\\s*$"));
    await shoot(page, "advisor", enable);
    expect(realApp.problems).toEqual([]);
  },
);
