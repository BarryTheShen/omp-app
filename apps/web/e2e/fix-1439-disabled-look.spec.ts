import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #1439 on real omp: while a section is disabled, its dropdowns, checkbox rows and structured editors' dropdowns must
 * look disabled the way its text boxes do. A Thinking Level conflict disables the Model tab's Thinking section, whose
 * number box is the reference. A Tool Approval conflict disables the Interaction tab's Tool Approval section, which
 * also holds a structured editor (Policy 1) beside its mode dropdown.
 */

const CONFLICT = "Another change arrived for Thinking Level";
const APPROVAL_CONFLICT = "Settings changed elsewhere";
// The Tool Approval section starts with one per-tool policy, so its structured editor has a row to draw.
const APPROVAL_START = "tools:\n  approvalMode: yolo\n  approval:\n    bash: allow\n";

type Look = { readonly opacity: string; readonly background: string; readonly cursor: string };

async function openModelThinking(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Model", exact: true }).click();
  const section = page.getByTestId("model-settings-thinking");
  await expect(section).toBeVisible({ timeout: 30_000 });
  return section;
}

// The checkbox row is the label around the checkbox: the control whose look the row shows.
function thinkingRow(section: Locator): Locator {
  return section
    .getByRole("checkbox", { name: "Hide Thinking Blocks", exact: true })
    .locator("xpath=..");
}

// Stages a Thinking Level change, then has another writer set the same setting: the section holds a conflict.
async function reachConflict(page: Page, agentDir: string): Promise<Locator> {
  const section = await openModelThinking(page);
  const level = section.getByRole("combobox", { name: "Thinking Level", exact: true });
  await expect(level).toBeEnabled({ timeout: 20_000 });
  // Before the conflict the controls look as they always have: fully opaque, and not shown as not-allowed.
  await expectLooksEnabled([level, thinkingRow(section)]);
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

/** Writes the settings file the way omp does: a temporary file, renamed over the target. */
async function writeSettingsFile(agentDir: string, content: string): Promise<void> {
  const target = join(agentDir, "config.yml");
  await writeFile(`${target}.tmp`, content);
  await rename(`${target}.tmp`, target);
}

// Opens Tool Approval, stages a mode change, then has another writer change the same setting: the section holds a
// conflict, which shows its heading and disables every control in the section.
async function reachApprovalConflict(page: Page, agentDir: string): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByRole("option", { name: "Tool Approval", exact: true }).click();
  const mode = settings.getByRole("combobox", { name: "Tool Approval", exact: true });
  const policy = settings.getByRole("combobox", { name: "Policy 1", exact: true });
  await expect(mode).toBeEnabled({ timeout: 30_000 });
  await expectLooksEnabled([mode, policy]);
  await mode.selectOption("write");
  await writeSettingsFile(
    agentDir,
    "tools:\n  approvalMode: always-ask\n  approval:\n    bash: allow\n",
  );
  await expect(settings.getByRole("heading", { name: APPROVAL_CONFLICT, exact: true })).toBeVisible(
    {
      timeout: 15_000,
    },
  );
  return settings;
}

async function capture(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await anchor.scrollIntoViewIfNeeded();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

// A text box's background transitions when it turns disabled, so its colours are read once the transitions end.
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await waitForFiniteAnimations(page);
}

function lookOf(control: Locator): Promise<Look> {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, background: style.backgroundColor, cursor: style.cursor };
  });
}

// Enabled controls look as they always have: fully opaque, and their pointer is not shown as not-allowed.
async function expectLooksEnabled(controls: readonly Locator[]): Promise<void> {
  for (const control of controls) {
    const look = await lookOf(control);
    expect(look.opacity).toBe("1");
    expect(look.cursor).not.toBe("not-allowed");
  }
}

// The reference is a disabled control the kit already draws: the number box, or the Tool Approval mode dropdown. It is
// half opacity, muted, with the not-allowed cursor. The number box's cursor is only computed, not shown: its pointer
// events are off while it is disabled (disabled:pointer-events-none), so a person never sees that cursor on it. The
// dropdowns and checkbox rows are seen, so each must compute the same look as the reference, cursor included.
async function expectLooksDisabled(reference: Locator, others: readonly Locator[]): Promise<void> {
  const muted = await lookOf(reference);
  expect(muted.opacity).toBe("0.5");
  expect(muted.cursor).toBe("not-allowed");
  for (const control of others) expect(await lookOf(control)).toEqual(muted);
}

async function expectThinkingLooksDisabled(page: Page, section: Locator): Promise<void> {
  const threshold = section.getByRole("spinbutton", {
    name: "Tool-Call Loop Threshold",
    exact: true,
  });
  const level = section.getByRole("combobox", { name: "Thinking Level", exact: true });
  const ceiling = section.getByRole("combobox", { name: "Auto Thinking Ceiling", exact: true });
  await expect(threshold).toBeDisabled();
  await expect(level).toBeDisabled();
  await expect(ceiling).toBeDisabled();
  await expect(
    section.getByRole("checkbox", { name: "Hide Thinking Blocks", exact: true }),
  ).toBeDisabled();
  await settle(page);
  await expectLooksDisabled(threshold, [level, ceiling, thinkingRow(section)]);
}

realTest(
  "a disabled dropdown and checkbox row look disabled, like the number box beside them",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1100 });
    const section = await reachConflict(page, realApp.agentDir);
    await expectThinkingLooksDisabled(page, section);
    await capture(page, "fix-1439-disabled-light.png", section);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the disabled dropdown and checkbox row look disabled in dark too",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });
    const section = await reachConflict(page, realApp.agentDir);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectThinkingLooksDisabled(page, section);
    await capture(page, "fix-1439-disabled-dark.png", section);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the disabled dropdown and checkbox row look disabled at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1100 });
    const section = await reachConflict(page, realApp.agentDir);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectThinkingLooksDisabled(page, section);
    await capture(page, "fix-1439-disabled-narrow.png", section);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a structured editor's dropdown in a conflicted section looks disabled, like the mode dropdown beside it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await writeSettingsFile(realApp.agentDir, APPROVAL_START);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1100 });
    const settings = await reachApprovalConflict(page, realApp.agentDir);
    const mode = settings.getByRole("combobox", { name: "Tool Approval", exact: true });
    const policy = settings.getByRole("combobox", { name: "Policy 1", exact: true });
    await expect(mode).toBeDisabled();
    await expect(policy).toBeDisabled();
    await settle(page);
    await expectLooksDisabled(mode, [policy]);
    await capture(page, "fix-1439-structured-light.png", mode);
    expect(realApp.problems).toEqual([]);
  },
);
