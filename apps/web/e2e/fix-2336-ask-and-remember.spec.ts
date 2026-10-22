/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  APP_ROOT,
  expect,
  REAL_OMP,
  realTest,
  screenshots,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * #2336 on real omp: omp's approval mode `always-ask-cached` ("Ask and remember", omp 18.12.3 and newer). A saved
 * Ask and remember shows as itself, not as Yolo, and Approval Mode offers it, saving it to omp's config.yml. The
 * harness default omp can be older than 18.12.3: then these tests skip, because omp itself refuses the mode.
 */

const NEEDS_OMP = "needs omp 18.12.3 or newer";

/**
 * Whether this omp saves `always-ask-cached`: omp's own `config set` accepts it in a throwaway home, the way the
 * app's server writes a setting. An older omp refuses the value and lists the values it accepts.
 */
async function ompSavesAskAndRemember(omp: string): Promise<boolean> {
  await mkdir(join(APP_ROOT, ".data"), { recursive: true });
  const root = await mkdtemp(join(APP_ROOT, ".data", "ask-and-remember-"));
  try {
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    await mkdir(home);
    await mkdir(agentDir);
    const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir };
    const result = spawnSync(omp, ["config", "set", "tools.approvalMode", "always-ask-cached"], {
      env,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status === 0) return true;
    // omp refuses a value it does not know and names the values it accepts; any other failure is not a skip.
    const output = `${result.stdout}${result.stderr}`;
    const accepted = /Valid values: (.+)$/m.exec(output)?.[1];
    if (accepted === undefined)
      throw new Error(`omp config set failed for another reason: ${output}`);
    if (
      accepted
        .split(",")
        .map((value) => value.trim())
        .includes("always-ask-cached")
    ) {
      throw new Error(`omp names always-ask-cached as valid, yet refused it: ${output}`);
    }
    return false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Opens Settings, then Interaction, then Approvals, and returns the screen and its Approval Mode dropdown. */
async function openApprovals(
  page: Page,
): Promise<{ readonly settings: Locator; readonly mode: Locator }> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Interaction", exact: true }).click();
  await page.getByRole("option", { name: "Approvals", exact: true }).click();
  const mode = settings.getByRole("combobox", { name: "Approval Mode", exact: true });
  await expect(mode).toBeEnabled({ timeout: 30_000 });
  return { settings, mode };
}

// The settings panels are styled from the design tokens: a probe with the token's colour must match the
// screen's computed background before anything is captured.
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

// Scrolls the dropdown into view, waits for the animations to finish, then captures the page.
async function capture(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await anchor.scrollIntoViewIfNeeded();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

realTest.setTimeout(240_000);

realTest(
  "real omp: a saved Ask and remember shows as Ask and remember in light, and at 390 px",
  async ({ realApp, ompBinary }, testInfo) => {
    testInfo.skip(!(await ompSavesAskAndRemember(ompBinary ?? REAL_OMP)), NEEDS_OMP);
    await writeFile(
      join(realApp.agentDir, "config.yml"),
      "tools:\n  approvalMode: always-ask-cached\n",
    );
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const { mode } = await openApprovals(page);
    await expect(mode).toHaveValue("always-ask-cached", { timeout: 30_000 });
    await expect(mode.locator("option:checked")).toHaveText("Ask and remember");
    await expect(mode.locator("option")).toHaveText([
      "Always ask",
      "Ask and remember",
      "Write",
      "Yolo",
    ]);
    await expectStyledSettings(page, "light");
    await capture(page, "fix-2336-ask-and-remember-light.png", mode);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(mode).toHaveValue("always-ask-cached");
    await capture(page, "fix-2336-ask-and-remember-390.png", mode);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: a saved Ask and remember shows as Ask and remember in dark",
  async ({ realApp, ompBinary }, testInfo) => {
    testInfo.skip(!(await ompSavesAskAndRemember(ompBinary ?? REAL_OMP)), NEEDS_OMP);
    await writeFile(
      join(realApp.agentDir, "config.yml"),
      "tools:\n  approvalMode: always-ask-cached\n",
    );
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const { mode } = await openApprovals(page);
    await expect(mode).toHaveValue("always-ask-cached", { timeout: 30_000 });
    await expect(mode.locator("option:checked")).toHaveText("Ask and remember");
    await expectStyledSettings(page, "dark");
    await capture(page, "fix-2336-ask-and-remember-dark.png", mode);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: choosing Ask and remember in Approvals saves it to omp's config.yml",
  async ({ realApp, ompBinary }, testInfo) => {
    testInfo.skip(!(await ompSavesAskAndRemember(ompBinary ?? REAL_OMP)), NEEDS_OMP);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const { settings, mode } = await openApprovals(page);
    await expect(mode).toHaveValue("yolo", { timeout: 30_000 });
    await mode.selectOption("always-ask-cached");
    await settings.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(settings.getByText("Applied", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/^\s+approvalMode:\s*always-ask-cached\s*$/m);

    // After a reload the control reads omp's saved value back.
    await page.reload();
    const reloaded = await openApprovals(page);
    await expect(reloaded.mode).toHaveValue("always-ask-cached", { timeout: 30_000 });
    expect(realApp.problems).toEqual([]);
  },
);
