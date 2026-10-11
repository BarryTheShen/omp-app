import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * S3.2 review fixes on the settings screen, on real omp: the Tools and Tasks labels and descriptions
 * a person reads, the notes that say which settings only omp's terminal (or its editor mode) reads,
 * and the apply status after a save. Each capture scrolls to the thing it shows, in the theme and
 * width its name says.
 */

const TERMINAL_ONLY_NOTE = "Used by omp's terminal only.";
const TERMINAL_AND_EDITOR_NOTE = "Used by omp's terminal and editor sessions only.";

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  return settings;
}

// Selects one section of a tab and returns the panel that holds its controls.
async function openSection(settings: Locator, tab: string, title: string): Promise<Locator> {
  await settings.getByRole("button", { name: tab, exact: true }).click();
  await settings.getByRole("option", { name: title }).click();
  const panel = settings.getByRole("region", { name: `${tab} settings`, exact: true });
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

// The settings panels are styled from the design tokens: a probe with the token's colour must
// match the screen's computed background before anything is captured.
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

// Scrolls the thing under review into view inside the settings dialog, then captures the viewport.
async function capture(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await anchor.first().evaluate((element) => element.scrollIntoView({ block: "center" }));
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name) });
}

async function saveAndWait(page: Page): Promise<void> {
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await save.click();
  await expect(save).toBeDisabled({ timeout: 20_000 });
}

realTest(
  "the Tools and Tasks labels, notes and apply status read plainly on real omp, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });
    const settings = await openSettings(page);
    await expectStyledSettings(page, "light");

    // Execution: the concurrency label has no repeated noun; the async job cap is in plain words.
    let panel = await openSection(settings, "Tools", "Execution");
    const concurrency = panel.getByText("Speculative Execution Concurrency", { exact: true });
    await expect(concurrency).toBeVisible();
    await expect(panel.getByText("Maximum Concurrent Async Jobs", { exact: true })).toBeVisible();
    await capture(page, "s3-2-execution-light.png", concurrency);

    panel = await openSection(settings, "Tools", "Output Limits");
    const tailLines = panel.getByText("Artifact Tail Lines", { exact: true });
    await expect(tailLines).toBeVisible();
    await capture(page, "s3-2-output-limits-light.png", tailLines);

    // Todos: the reminder limit label has no repeated noun; the terminal-only note is on screen,
    // and saving a live setting reads "Applied".
    panel = await openSection(settings, "Tools", "Todos");
    await expect(panel.getByText("Todo Reminder Limit", { exact: true })).toBeVisible();
    const autoClear = panel.getByText("Todo Auto-Clear Delay (seconds)", { exact: true });
    await expect(autoClear).toBeVisible();
    await expect(panel.getByText(TERMINAL_ONLY_NOTE)).toHaveCount(1);
    await panel
      .getByRole("spinbutton", { name: "Todo Auto-Clear Delay (seconds)", exact: true })
      .fill("90");
    await saveAndWait(page);
    const applied = panel.getByText("Applied", { exact: true });
    await expect(applied).toBeVisible({ timeout: 20_000 });
    await capture(page, "s3-2-todos-applied-light.png", applied);

    // Extensions: the tool-call timeout reads as a plain description, not developer text.
    panel = await openSection(settings, "Tools", "Extensions");
    const timeout = panel.getByText("Tool Call Handler Timeout (ms)", { exact: true });
    await expect(timeout).toBeVisible();
    await expect(
      panel.getByText(
        "How long an extension's tool-call handler may work before it is stopped. A value that is not above 0 uses 30,000 ms; time spent waiting for a dialog does not count.",
        { exact: true },
      ),
    ).toBeVisible();
    await capture(page, "s3-2-extensions-light.png", timeout);

    // Subagents: three labels without the repeated noun.
    panel = await openSection(settings, "Tasks", "Subagents");
    const middle = panel.getByText("Max Task Recursion Depth", { exact: true });
    await expect(panel.getByText("Max Concurrent Tasks", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(middle).toBeVisible();
    const soft = panel.getByText("Soft Subagent Request Budget", { exact: true });
    await expect(soft).toBeVisible();
    await capture(page, "s3-2-subagents-light.png", middle);
    await capture(page, "s3-2-subagents-soft-light.png", soft);

    // Modes: the two terminal-only notes, the editor-and-terminal notes, and the restart status.
    panel = await openSection(settings, "Tasks", "Modes");
    const goalStatus = panel.getByText("Goal Status in Footer", { exact: true });
    await expect(goalStatus).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(TERMINAL_ONLY_NOTE)).toHaveCount(2);
    await expect(panel.getByText(TERMINAL_AND_EDITOR_NOTE)).toHaveCount(2);
    await capture(page, "s3-2-modes-light.png", goalStatus);
    await panel.getByRole("checkbox", { name: "Start in Plan Mode", exact: true }).check();
    await saveAndWait(page);
    const restart = panel.getByText("Restart required", { exact: true });
    await expect(restart).toBeVisible({ timeout: 20_000 });
    await capture(page, "s3-2-modes-restart-light.png", restart);

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the Tasks modes notes and the Todos label read plainly on real omp, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });
    const settings = await openSettings(page);
    await expectStyledSettings(page, "dark");

    let panel = await openSection(settings, "Tools", "Todos");
    const autoClear = panel.getByText("Todo Auto-Clear Delay (seconds)", { exact: true });
    await expect(autoClear).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(TERMINAL_ONLY_NOTE)).toHaveCount(1);
    await capture(page, "s3-2-todos-dark.png", autoClear);

    panel = await openSection(settings, "Tasks", "Modes");
    const autosave = panel.getByText("Autosave Plans", { exact: true });
    await expect(autosave).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(TERMINAL_AND_EDITOR_NOTE)).toHaveCount(2);
    await capture(page, "s3-2-modes-dark.png", autosave);

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the Tasks modes notes and the timeout description fit at 390 px on real omp",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const settings = await openSettings(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectStyledSettings(page, "dark");

    let panel = await openSection(settings, "Tools", "Extensions");
    const timeout = panel.getByText("Tool Call Handler Timeout (ms)", { exact: true });
    await expect(timeout).toBeVisible({ timeout: 20_000 });
    await capture(page, "s3-2-extensions-narrow.png", timeout);

    panel = await openSection(settings, "Tasks", "Modes");
    const startPlan = panel.getByRole("checkbox", { name: "Start in Plan Mode", exact: true });
    await expect(startPlan).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(TERMINAL_ONLY_NOTE)).toHaveCount(2);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await capture(page, "s3-2-modes-narrow.png", startPlan);

    expect(realApp.problems).toEqual([]);
  },
);
