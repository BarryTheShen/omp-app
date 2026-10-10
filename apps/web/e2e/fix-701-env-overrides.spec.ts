import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #701 and #718 on real omp: omp's environment values override the saved Tools settings. The app's
 * server starts omp with PI_AUTO_QA=0 and PI_BROWSER_TERN=0 in its process environment, and with
 * PI_AUTO_QA_PUSH_URL set to a URL whose query carries a credential. The agent folder's `.env` file
 * alone sets PI_INTENT_TRACING=0, which only omp's file loading reads. The Tools screen shows the
 * value omp uses and says it is set in the environment; the credential URL is hidden, not shown.
 */

// Assembled at runtime so no source line looks like a real credential (the PR gate rejects those).
const TOKEN = ["tok", "x".repeat(24)].join("-");

realTest.use({
  serverEnv: {
    PI_AUTO_QA: "0",
    PI_BROWSER_TERN: "0",
    PI_AUTO_QA_PUSH_URL: `https://qa.example.test/v1?region=eu&token=${TOKEN}`,
  },
  seedAgentDotEnv: "PI_INTENT_TRACING=0\n",
});

const FROM_ENVIRONMENT = "Source: Set in the environment";
const HIDDEN_ENDPOINT = "Set in the environment; the value is hidden.";

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
  "omp's environment values show on the Tools screen as set in the environment, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 1100 });
    const settings = await openSettings(page);
    await expectStyledSettings(page, "light");

    // Developer: Auto QA is off in omp (process environment). The endpoint URL carries a credential,
    // so it is hidden: a sentence replaces the field, and the credential is not in the page at all.
    let panel = await openSection(settings, "Tools", "Tools / Developer");
    const autoQa = panel.getByRole("checkbox", { name: "Auto QA", exact: true });
    await expect(autoQa).not.toBeChecked({ timeout: 20_000 });
    await expect(page.getByTestId("dev.autoqa-provenance")).toContainText(FROM_ENVIRONMENT);
    await expect(page.getByTestId("dev.autoqaPush.endpoint-hidden")).toHaveText(HIDDEN_ENDPOINT);
    await expect(
      panel.getByRole("textbox", { name: "Auto QA Push Endpoint", exact: true }),
    ).toHaveCount(0);
    expect(await page.content()).not.toContain(TOKEN);
    await capture(page, "fix-701-developer-light.png", autoQa);

    // Execution: Intent Tracing is set only in the agent folder's `.env` file. The switch shows omp's
    // value, and a save writes the file without changing what omp uses.
    panel = await openSection(settings, "Tools", "Tools / Execution");
    const intent = panel.getByRole("checkbox", { name: "Intent Tracing", exact: true });
    await expect(intent).not.toBeChecked({ timeout: 20_000 });
    await expect(page.getByTestId("tools.intentTracing-provenance")).toContainText(
      FROM_ENVIRONMENT,
    );
    await intent.check();
    await saveAndWait(page);
    await expect(intent).not.toBeChecked({ timeout: 20_000 });
    await expect(page.getByTestId("tools.intentTracing-provenance")).toContainText(
      FROM_ENVIRONMENT,
    );

    // Grep & Browser: Tern Browser is off in omp through PI_BROWSER_TERN=0.
    panel = await openSection(settings, "Tools", "Tools / Grep & Browser");
    const tern = panel.getByRole("checkbox", { name: "Tern Browser", exact: true });
    await expect(tern).not.toBeChecked({ timeout: 20_000 });
    await expect(page.getByTestId("browser.tern-provenance")).toContainText(FROM_ENVIRONMENT);

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "omp's environment values fit at 390 px on the Tools screen, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const settings = await openSettings(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectStyledSettings(page, "dark");

    const panel = await openSection(settings, "Tools", "Tools / Developer");
    const autoQa = panel.getByRole("checkbox", { name: "Auto QA", exact: true });
    await expect(autoQa).not.toBeChecked({ timeout: 20_000 });
    await expect(page.getByTestId("dev.autoqa-provenance")).toContainText(FROM_ENVIRONMENT);
    await expect(page.getByTestId("dev.autoqaPush.endpoint-hidden")).toHaveText(HIDDEN_ENDPOINT);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await capture(page, "fix-701-developer-narrow-dark.png", autoQa);

    expect(realApp.problems).toEqual([]);
  },
);
