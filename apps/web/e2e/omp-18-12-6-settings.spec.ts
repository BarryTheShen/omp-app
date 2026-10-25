/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";
import { ensurePlaygroundBuilt } from "./playground-build";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #2632. omp 18.12 added six settings to its own settings screen and one model role. Each has a control in the
 * app, next to its omp group's other controls: Auto Prewalk and its target (Model, Prewalk), Computer Background
 * Fallback (Tools, Computer), Live Job Widgets (Tools, Execution), Complete Scrollback (Appearance, Display), Advisor
 * Continue Severity (the advisor surface) and the Job widgets role (the model dialog's Roles view). On real omp, each
 * test changes the controls in the app and checks that omp's own config.yml got the value, then captures the section
 * in light, in dark and at 390 px.
 */

const FAKE_HAIKU = /fake\/claude-3-haiku-20240307 ·/;

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

/**
 * Captures what `anchor` shows in light, in dark and at 390 px (no sideways scrolling), then puts the page back as it was.
 * Files: `omp-18-12-6-<name>-light.png`, `-dark.png` and `-390.png` under the screenshots folder.
 */
async function shoot(page: Page, name: string, anchor: Locator): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  const wide = page.viewportSize() ?? { width: 1280, height: 1000 };
  const capture = async (mode: "light" | "dark" | "390"): Promise<void> => {
    await anchor.first().evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, `omp-18-12-6-${name}-${mode}.png`) });
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

/** Selects one section of a Model or Tools tab and returns the panel that holds its controls. */
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
  await expect(panel.getByText("Applied", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
}

realTest(
  "the Prewalk, Computer, Execution and Display controls omp 18.12 added save to omp's config",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1000 });
    const settings = await openSettings(page);

    // Model, Prewalk: Auto Prewalk is Off and its target @smol until a person changes them.
    const prewalk = await openSection(settings, "Model", "Prewalk");
    const auto = prewalk.getByRole("combobox", { name: "Auto Prewalk", exact: true });
    const target = prewalk.getByRole("textbox", { name: "Auto-Prewalk Target", exact: true });
    await expect(auto.locator("option")).toHaveText(["Off", "Suggest", "On"], { timeout: 30_000 });
    await expect(auto).toHaveValue("off", { timeout: 30_000 });
    await expect(target).toHaveValue("@smol", { timeout: 30_000 });
    await expect(prewalk.getByText(/^Ask the judge model \(the Judge role\)/)).toBeVisible();
    await expect(prewalk.getByText(/^Model or role that auto-prewalk hands off to/)).toBeVisible();
    await auto.selectOption("suggest");
    await target.fill("@slow");
    await save(prewalk);
    await expectConfig(realApp, nested("prewalk", "auto", "suggest"));
    await expectConfig(realApp, nested("prewalk", "autoTarget", `["']?@slow["']?`));
    await shoot(page, "prewalk", auto);

    // Tools, Computer: Takeover until a person chooses Refuse.
    const computer = await openSection(settings, "Tools", "Computer");
    const fallback = computer.getByRole("combobox", {
      name: "Computer Background Fallback",
      exact: true,
    });
    await expect(fallback.locator("option")).toHaveText(["Takeover", "Refuse"], {
      timeout: 30_000,
    });
    await expect(fallback).toHaveValue("takeover", { timeout: 30_000 });
    await expect(computer.getByText(/^What window input does when it cannot run/)).toBeVisible();
    await fallback.selectOption("refuse");
    await save(computer);
    await expectConfig(realApp, nested("computer", "backgroundFallback", "refuse"));
    await shoot(page, "computer", fallback);

    // Tools, Execution: Live Job Widgets is on until a person turns it off.
    const execution = await openSection(settings, "Tools", "Execution");
    const widgets = execution.getByRole("checkbox", { name: "Live Job Widgets", exact: true });
    await expect(widgets).toBeChecked({ timeout: 30_000 });
    await expect(
      execution.getByText(/^Draw a live widget for each running background job/),
    ).toBeVisible();
    await widgets.uncheck();
    await save(execution);
    await expectConfig(realApp, nested("async", "widgets", "false"));
    await shoot(page, "execution", widgets);

    // Appearance, Display: Complete Scrollback is off, and says it is for omp's terminal only.
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    await settings
      .getByRole("tablist", { name: "Appearance sections", exact: true })
      .getByRole("tab", { name: "Display", exact: true })
      .click();
    const display = page.locator('[data-s1-appearance-section="S1.appearanceDisplay"]');
    await expect(display).toBeVisible();
    const scrollback = display.getByRole("checkbox", { name: "Complete Scrollback", exact: true });
    await expect(scrollback).not.toBeChecked({ timeout: 30_000 });
    await expect(
      display.getByText(/^Terminal only\. Send transcript rows pushed off screen/),
    ).toBeVisible();
    await scrollback.check();
    await save(display);
    await expectConfig(realApp, nested("tui", "completeScrollback", "true"));
    await shoot(page, "display", scrollback);

    expect(realApp.problems).toEqual([]);
  },
);

/** Starts a chat, waits for omp's first answer, and opens the chat's model dialog from the header button. */
async function openModelDialog(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await sendPrompt(composer, "ping");
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
  // A CSS locator: while the dialog is open the header is hidden from role queries.
  await page.locator('[data-layout-area="composerToolbar"] button[aria-label^="Model:"]').click();
  const dialog = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(dialog).toBeVisible();
  return dialog;
}

realTest(
  "the Job widgets role is listed after Advisor, and a model chosen for it is written to omp's config",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);
    await dialog.getByRole("button", { name: /^Roles/ }).click();
    const chatRoles = dialog.getByRole("region", { name: "Chat roles" });
    await expect(chatRoles).toBeVisible();

    // omp's order (`MODEL_ROLE_IDS`, model-browser.ts:72-89 at v18.12.6): Advisor, then Job widgets.
    const names = await chatRoles
      .getByRole("button", { name: /^Choose a model for / })
      .evaluateAll((buttons) =>
        buttons.map((button) =>
          (button.getAttribute("aria-label") ?? "").replace(/^Choose a model for /, ""),
        ),
      );
    expect(names.indexOf("Job widgets")).toBe(names.indexOf("Advisor") + 1);
    expect(names.indexOf("Advisor")).toBeGreaterThan(-1);

    await dialog.getByRole("button", { name: "Choose a model for Job widgets" }).click();
    await expect(dialog.getByText("Choose a model for Job widgets.")).toBeVisible();
    await dialog.getByRole("button", { name: FAKE_HAIKU }).click();
    await expect(dialog.getByText("Job widgets now uses Claude Haiku 3.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByRole("button", { name: "Clear Job widgets" })).toBeVisible();
    await expectConfig(realApp, /^\s+widget:\s*["']?fake\/claude-3-haiku-20240307["']?\s*$/m);
    await shoot(page, "widget-role", dialog.getByRole("button", { name: "Clear Job widgets" }));
    expect(realApp.problems).toEqual([]);
  },
);

const WEB_ROOT = process.cwd();
const DIST_ROOT = join(WEB_ROOT, "dist");
const PAGE_NAME = "omp-18-12-6-advisor-live";
const PAGE_ROOT = join(DIST_ROOT, PAGE_NAME);

/** The advisor surface as a page of its own, the way `p1-7-advisor.spec.ts` builds it: no screen mounts it yet. */
function buildAdvisorPage(): void {
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for the advisor.");
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/P1/advisor/live-playground.tsx",
      "--outdir",
      PAGE_ROOT,
      "--target=browser",
    ],
    { cwd: WEB_ROOT, stdio: "inherit" },
  );
  writeFileSync(
    join(DIST_ROOT, `${PAGE_NAME}.html`),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/${PAGE_NAME}/live-playground.js"></script>
  </head>
  <body><div id="p1-7-advisor-live-root"></div></body>
</html>
`,
  );
}

async function openAdvisor(
  browser: Browser,
  origin: string,
  token: string,
  thread: string,
): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(
    `${origin}/${PAGE_NAME}.html?thread=${encodeURIComponent(thread)}#token=${encodeURIComponent(token)}`,
  );
  await expect(page.getByTestId("p1-advisor-live")).toBeVisible({ timeout: 80_000 });
  return page;
}

realTest(
  "Advisor Continue Severity lists nit, concern and blocker, and a choice is written to omp's config",
  async ({ realApp, browser }, testInfo) => {
    testInfo.setTimeout(240_000);
    ensurePlaygroundBuilt(() => {
      buildAdvisorPage();
    });
    const app = await realApp.open();
    const composer = await startChat(app);
    // The chat's omp session exists once it has answered, so its id can name the page's chat.
    await sendPrompt(composer, "ping");
    await expect(app.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
    const readThread = () => app.evaluate(() => window.localStorage.getItem("omp.app.root.thread"));
    await expect.poll(readThread, { timeout: 60_000 }).toBeTruthy();
    const thread = (await readThread()) ?? "";
    const page = await openAdvisor(browser, new URL(app.url()).origin, realApp.token, thread);

    const severity = page.getByRole("combobox", { name: "Advisor Continue Severity", exact: true });
    await expect(severity.locator("option")).toHaveText(["Nit", "Concern", "Blocker"]);
    // omp's default is concern; the words are omp's own, with no code marks.
    await expect(severity).toHaveValue("concern");
    await expect(
      page.getByText(/^Minimum severity of an advisor note that wakes the agent/),
    ).toBeVisible();
    await severity.selectOption("blocker");
    const saveButton = page.getByRole("button", { name: "Save Advisor Continue Severity" });
    await saveButton.click();
    await expect(saveButton).toBeEnabled();
    await expectConfig(realApp, nested("advisor", "continueSeverity", "blocker"));

    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Advisor Continue Severity", exact: true }),
    ).toHaveValue("blocker");
    await shoot(page, "advisor", severity);
    expect(realApp.problems).toEqual([]);
  },
);
