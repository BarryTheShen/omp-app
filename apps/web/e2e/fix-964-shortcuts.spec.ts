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

/** Captures the same state in light, dark and at 390 px, leaving the page in light at its wide width. */
async function captureThreeWays(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(screenshots, `${name}-light.png`) });
  await setTheme(page, true);
  await page.screenshot({ path: join(screenshots, `${name}-dark.png`) });
  await setTheme(page, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.screenshot({ path: join(screenshots, `${name}-narrow.png`) });
  await page.setViewportSize({ width: 1280, height: 900 });
}

realTest(
  "#964 part 2: Alt+A opens the Agent Hub with the Panels sidebar collapsed, in light, dark and at 390 px",
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

    await page.getByRole("button", { name: "Hide panels sidebar" }).click();
    await expect(panels(page)).toHaveAttribute("data-open", "false");
    await composer.click();
    await page.keyboard.press("Alt+A");
    await expect(panels(page)).toHaveAttribute("data-open", "true");
    await expect(agentHub(page)).toBeVisible();
    await expectStylesLoaded(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-964-p2-hub-light.png") });
    await setTheme(page, true);
    await expect(agentHub(page)).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-964-p2-hub-dark.png") });
    await setTheme(page, false);

    // The narrow layout closes both sidebars when it takes effect (app-shell.tsx); Alt+A opens the overlay again.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panels(page)).toHaveAttribute("data-open", "false");
    await composer.click();
    await page.keyboard.press("Alt+A");
    await expect(panels(page)).toHaveAttribute("data-open", "true");
    await expect(agentHub(page)).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-964-p2-hub-narrow.png") });

    // Stop the long worker so the chat does not keep it running after the test.
    await page.setViewportSize({ width: 1280, height: 900 });
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
  "#964 part 2: Alt+Shift+L copies the current line and Alt+Shift+C copies the prompt, leaving the draft as it is",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    const composer = await startChat(page);
    await composer.fill("first line\nsecond line");
    await composer.focus();

    await page.keyboard.press("Alt+Shift+L");
    await expect(page.getByText("Copied the current line.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("second line");

    await page.keyboard.press("Alt+Shift+C");
    await expect(page.getByText("Copied the prompt.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "first line\nsecond line",
    );
    await expect(composer).toHaveValue("first line\nsecond line");
    await expectStylesLoaded(page);
    await captureThreeWays(page, "fix-964-p2-copy");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#964 part 2: Alt+Shift+V pastes the clipboard as plain text at the caret",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    const composer = await startChat(page);
    await page.evaluate(() => navigator.clipboard.writeText("pasted line"));
    await composer.fill("ab");
    await composer.press("ArrowLeft");
    await expect(composer).toBeFocused();

    await page.keyboard.press("Alt+Shift+V");
    await expect(composer).toHaveValue("apasted lineb");
    await expectStylesLoaded(page);
    await captureThreeWays(page, "fix-964-p2-paste");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#964 part 2: Alt+R does nothing while no turn has failed: the draft stays and no retry starts",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 60_000 });
    await composer.fill("keep this draft");
    await composer.focus();

    await page.keyboard.press("Alt+R");
    await expect(composer).toHaveValue("keep this draft");
    await expect(page.getByText("Try again")).toHaveCount(0);
    await expectStylesLoaded(page);
    await captureThreeWays(page, "fix-964-p2-retry");
    expect(realApp.problems).toEqual([]);
  },
);
