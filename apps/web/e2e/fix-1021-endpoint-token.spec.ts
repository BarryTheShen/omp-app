import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1021. A saved endpoint whose query carries a token is hidden, and its row used to show only a sentence.
 * The row now offers Replace and Unset, as the secrets do: Replace takes a new address and never shows the typed
 * text again, Unset removes the saved address. The token never reaches the page or the debug log.
 */

// Assembled at runtime so no source line looks like a real credential (the PR gate rejects those).
const TOKEN = ["tok", "x".repeat(24)].join("-");
const NEW_TOKEN = ["tok", "y".repeat(24)].join("-");
const SENTENCE = "Saved for all projects; the value is hidden.";

/** Opens Settings, Tools and the Developer page, and returns the Tools settings panel. */
async function openDeveloper(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Tools", exact: true }).click();
  await settings.getByRole("option", { name: "Developer", exact: true }).click();
  const panel = settings.getByRole("region", { name: "Tools settings", exact: true });
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

/** Saves an endpoint in the agent folder's config.yml, the file a saved setting is read from. */
async function saveEndpoint(agentDir: string, url: string): Promise<void> {
  await writeFile(
    join(agentDir, "config.yml"),
    `dev:\n  autoqaPush:\n    endpoint: ${JSON.stringify(url)}\n`,
    "utf8",
  );
}

/** The agent folder's config.yml as it is on disk now. */
function configOn(agentDir: string): Promise<string> {
  return readFile(join(agentDir, "config.yml"), "utf8");
}

realTest(
  "a saved endpoint with a token offers Replace and Unset; Replace keeps a token address hidden; Unset removes it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await saveEndpoint(realApp.agentDir, `https://qa.example.test/v1?token=${TOKEN}`);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const panel = await openDeveloper(page);

    const sentence = page.getByTestId("dev.autoqaPush.endpoint-hidden");
    await expect(sentence).toHaveText(SENTENCE);
    const replace = panel.getByRole("button", { name: "Replace…", exact: true });
    await expect(replace).toBeVisible();
    await expect(panel.getByRole("button", { name: "Unset", exact: true })).toBeVisible();
    await sentence.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1021-hidden-light.png") });

    await replace.click();
    const field = panel.getByLabel("New address");
    await expect(field).toHaveAttribute("type", "password");
    await expect(field).toBeFocused();
    await expect(panel.getByText("New address", { exact: true })).toHaveCSS("font-weight", "500");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1021-replace-light.png") });

    // A new address that still carries a token is saved, and stays hidden.
    await field.fill(`https://qa.example.test/v2?token=${NEW_TOKEN}`);
    await panel.getByRole("button", { name: "Use this address", exact: true }).click();
    await expect(panel.getByText("A new address is ready to save.")).toBeVisible();
    await expect(replace).toBeFocused();
    await panel.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect
      .poll(() => configOn(realApp.agentDir), { timeout: 20_000 })
      .toContain("qa.example.test/v2");
    await expect(sentence).toHaveText(SENTENCE);
    expect(await page.content()).not.toContain(NEW_TOKEN);
    expect(realApp.log()).not.toContain(NEW_TOKEN);

    // Unset removes the saved address, and the field returns to a plain value.
    await panel.getByRole("button", { name: "Unset", exact: true }).click();
    await expect(panel.getByText("Will be unset when you save.")).toBeVisible();
    await panel.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect
      .poll(() => configOn(realApp.agentDir), { timeout: 20_000 })
      .not.toContain("qa.example.test");
    await expect(panel.getByRole("textbox", { name: "Auto QA Push Endpoint" })).toBeVisible({
      timeout: 20_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("a saved endpoint with a token reads in dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  await saveEndpoint(realApp.agentDir, `https://qa.example.test/v1?token=${TOKEN}`);
  const page = await realApp.open();
  await page.setViewportSize({ width: 1280, height: 900 });
  const panel = await openDeveloper(page);
  const sentence = page.getByTestId("dev.autoqaPush.endpoint-hidden");
  await expect(sentence).toHaveText(SENTENCE);
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const background = () => dialog.evaluate((element) => getComputedStyle(element).backgroundColor);
  const light = await background();

  // The app follows the system's colour scheme, so switching the scheme switches the app.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(background, { timeout: 10_000 }).not.toBe(light);
  await expect(panel).toBeVisible();
  await sentence.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1021-hidden-dark.png") });
  await panel.getByRole("button", { name: "Replace…", exact: true }).click();
  await expect(panel.getByLabel("New address")).toBeFocused();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1021-replace-dark.png") });
  expect(realApp.problems).toEqual([]);
});

realTest("a saved endpoint with a token fits a 390 px phone", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  await saveEndpoint(realApp.agentDir, `https://qa.example.test/v1?token=${TOKEN}`);
  const page = await realApp.open();
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openDeveloper(page);
  const sentence = page.getByTestId("dev.autoqaPush.endpoint-hidden");
  await expect(sentence).toHaveText(SENTENCE);
  await expect(panel.getByRole("button", { name: "Replace…", exact: true })).toBeVisible();
  await sentence.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await waitForFiniteAnimations(page);
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
  await page.screenshot({ path: join(screenshots, "fix-1021-hidden-narrow.png") });
  await panel.getByRole("button", { name: "Replace…", exact: true }).click();
  await expect(panel.getByLabel("New address")).toBeFocused();
  await waitForFiniteAnimations(page);
  const fitsWithField = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fitsWithField).toBe(true);
  await page.screenshot({ path: join(screenshots, "fix-1021-replace-narrow.png") });
  expect(realApp.problems).toEqual([]);
});
