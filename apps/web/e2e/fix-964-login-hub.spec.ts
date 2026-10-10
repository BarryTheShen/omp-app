import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** The provider login page, opened as a dialog over the chat. */
function loginDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Provider login" });
}

/** omp's slash command list above the composer. */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/** The Agent Hub: the live roster of the chat's subagents. */
function agentHub(page: Page): Locator {
  return page.getByRole("region", { name: "Agent Hub" });
}

/** The right sidebar. Collapsed, it is hidden from the accessibility tree, so it is found by its attribute. */
function panels(page: Page): Locator {
  return page.locator('[data-shell-sidebar="right"]');
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

/** Two ← presses close together in the empty composer: the gesture omp's docs describe for the Agent Hub. */
async function doubleTapLeft(page: Page, composer: Locator): Promise<void> {
  await composer.click();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "#964: typing /login and sending it opens the provider login page over the chat; Escape returns focus to the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await composer.fill("/login");
    await expect(commandList(page).getByRole("option", { name: /^\/login/ })).toBeVisible({
      timeout: 30_000,
    });
    // /login takes no arguments, so the one Enter that chooses it also runs it.
    await composer.press("Enter");

    const dialog = loginDialog(page);
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole("heading", { name: "Provider login" })).toBeVisible();
    await expectStylesLoaded(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-964-login-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-964-login-narrow.png") });

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(composer).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#964: the palette's Provider login opens the same page in dark mode; Escape returns focus to the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const composer = await startChat(page);
    await composer.click();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("login");
    await page.getByRole("option", { name: /^Provider login/ }).click();

    const dialog = loginDialog(page);
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expectStylesLoaded(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-964-login-dark.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(composer).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#964: a double-tap of ← in an empty composer opens the Agent Hub, even with the Panels sidebar collapsed",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_long_subagent");
    await page.getByRole("tab", { name: "Agents" }).click();
    const running = agentHub(page).getByRole("option", { name: /Running/ });
    await expect(running).toHaveCount(1, { timeout: 120_000 });

    await page.getByRole("button", { name: "Collapse panels sidebar" }).click();
    await expect(panels(page)).toHaveAttribute("data-open", "false");

    await doubleTapLeft(page, composer);
    await expect(panels(page)).toHaveAttribute("data-open", "true");
    await expect(agentHub(page)).toBeVisible();
    await expect(agentHub(page).getByRole("option", { name: /Running/ })).toHaveCount(1);
    await expectStylesLoaded(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-964-hub-light.png") });
    await setTheme(page, true);
    await expect(agentHub(page)).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-964-hub-dark.png") });
    await setTheme(page, false);

    // The narrow layout closes both sidebars when it takes effect (app-shell.tsx), so the hub closes here.
    // The phone check then opens it again from the composer: the narrow overlay is the path that matters.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panels(page)).toHaveAttribute("data-open", "false");
    await doubleTapLeft(page, composer);
    await expect(panels(page)).toHaveAttribute("data-open", "true");
    await expect(agentHub(page)).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-964-hub-narrow.png") });

    // Stop the long worker so the chat does not keep it running after the test.
    await running.click();
    await agentHub(page)
      .getByRole("button", { name: /^Cancel / })
      .click();
    await expect(agentHub(page).getByRole("option", { name: /Cancelled/ })).toHaveCount(1, {
      timeout: 60_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);
