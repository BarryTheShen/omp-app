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
  // Two frames: a style change made just before (a sidebar closing, a viewport resize) starts its CSS transition in the
  // first; the wait below then sees it and waits for it to end.
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/** Types /hub and sends it. The command takes no arguments, so the Enter that chooses it also runs it. */
async function sendHub(page: Page, composer: Locator): Promise<void> {
  await composer.fill("/hub");
  await expect(
    page.getByRole("listbox", { name: "Slash commands" }).getByRole("option", { name: /^\/hub/ }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await composer.press("Enter");
}

realTest(
  "#1257: typing /hub while a worker runs opens the Agent Hub with the worker listed; the shortcut sheet lists /hub",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
      expectApp: false,
    });
    // The helper waits 5 s for the app; a loaded machine can take longer to mount it, so wait for the root with a bound it needs.
    await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 60_000 });
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_long_subagent");
    await page.getByRole("tab", { name: "Agents" }).click();
    const running = agentHub(page).getByRole("option", { name: /Running/ });
    await expect(running).toHaveCount(1, { timeout: 120_000 });

    await page.getByRole("button", { name: "Hide panels sidebar" }).click();
    await expect(panels(page)).toHaveAttribute("data-open", "false");

    await sendHub(page, composer);
    await expect(panels(page)).toHaveAttribute("data-open", "true");
    await expect(agentHub(page)).toBeVisible();
    await expect(agentHub(page).getByRole("option", { name: /Running/ })).toHaveCount(1);
    await expectStylesLoaded(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1257-hub-light.png") });
    await setTheme(page, true);
    await expect(agentHub(page)).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-1257-hub-dark.png") });
    await setTheme(page, false);

    // The palette's Keyboard shortcuts item opens the sheet, which lists /hub under Typed commands.
    await composer.click();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("keyboard");
    await page.getByRole("option", { name: /^Keyboard shortcuts/ }).click();
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("heading", { name: "Typed commands" })).toBeVisible();
    await expect(sheet.getByText("/hub", { exact: true })).toBeVisible();
    // The sheet lists its groups first; the typed commands sit below them, so the capture scrolls to them.
    await sheet.getByRole("heading", { name: "Typed commands" }).scrollIntoViewIfNeeded();
    await expectStylesLoaded(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1257-sheet-light.png") });
    await setTheme(page, true);
    await expect(sheet.getByText("/hub", { exact: true })).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-1257-sheet-dark.png") });
    await setTheme(page, false);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // The narrow layout closes the sidebars, so /hub opens the hub again as the narrow overlay.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panels(page)).toHaveAttribute("data-open", "false");
    await sendHub(page, composer);
    await expect(panels(page)).toHaveAttribute("data-open", "true");
    await expect(agentHub(page)).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1257-hub-narrow.png") });

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

realTest(
  "#1257: typing /hub in a chat with no agent says so in the header and opens nothing",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
      expectApp: false,
    });
    await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 60_000 });
    const composer = await startChat(page);
    await sendHub(page, composer);

    await expect(
      page.getByRole("status").filter({ hasText: "No agents to show yet." }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(agentHub(page).getByRole("option")).toHaveCount(0);
    await expectStylesLoaded(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1257-hub-empty-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    // A sidebar's visibility changes only when its closing transition ends, so hidden means the capture is settled.
    await expect(panels(page)).toBeHidden();
    await expect(page.locator('[data-shell-sidebar="left"]')).toBeHidden();
    await expect(
      page.getByRole("status").filter({ hasText: "No agents to show yet." }),
    ).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1257-hub-empty-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
