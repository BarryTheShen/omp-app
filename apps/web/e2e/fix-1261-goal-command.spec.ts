import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/** The header line that says what a command did. */
function statusLine(page: Page, text: string | RegExp): Locator {
  return page.getByRole("status").filter({ hasText: text });
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

/** Types a command and sends it. A command typed alone is chosen by the Enter that sends it, so its option must show first. */
async function sendCommand(page: Page, composer: Locator, text: string): Promise<void> {
  await composer.fill(text);
  await expect(
    page.getByRole("listbox", { name: "Slash commands" }).getByRole("option", { name: /^\/goal/ }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await composer.press("Enter");
}

/** Sends text that takes arguments with the Send button. Enter is held while the command list loads its results, and a held Enter for a command with arguments is dropped (issue 818), so a fill and an Enter can race the list under load. */
async function sendTyped(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Send message" }).click();
}

/** Runs one palette goal command by its title. */
async function runPaletteGoal(page: Page, composer: Locator, title: string): Promise<void> {
  await composer.click();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("goal");
  await page.getByRole("option", { name: new RegExp(`^${title}`) }).click();
}

realTest(
  "#1261: typed /goal sets, shows, pauses, resumes and drops the goal; a budget change says why it is refused; the shortcut sheet lists /goal",
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

    await sendCommand(page, composer, "/goal");
    await expect(statusLine(page, "No goal is set for this chat.")).toBeVisible({
      timeout: 60_000,
    });

    await composer.fill("/goal Ship the release notes");
    await sendTyped(page);
    await expect(statusLine(page, "Goal set: Ship the release notes. Status: Active.")).toBeVisible(
      { timeout: 60_000 },
    );
    await expectStylesLoaded(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1261-goal-set-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1261-goal-set-dark.png") });
    await setTheme(page, false);

    await sendCommand(page, composer, "/goal");
    await expect(statusLine(page, "Goal: Ship the release notes. Status: Active.")).toBeVisible({
      timeout: 60_000,
    });

    await composer.fill("/goal pause");
    await sendTyped(page);
    await expect(
      statusLine(page, "Goal paused: Ship the release notes. Status: Paused."),
    ).toBeVisible({ timeout: 60_000 });

    await composer.fill("/goal resume");
    await sendTyped(page);
    await expect(
      statusLine(page, "Goal resumed: Ship the release notes. Status: Active."),
    ).toBeVisible({ timeout: 60_000 });

    await composer.fill("/goal budget 500");
    await sendTyped(page);
    await expect(
      page.getByText(
        "Changing a goal's token budget is not in the app yet. Use omp's terminal for it.",
      ),
    ).toBeVisible({ timeout: 60_000 });
    await expect(composer).toHaveValue("/goal budget 500");

    await composer.fill("/goal drop");
    await sendTyped(page);
    await expect(statusLine(page, /Goal dropped/)).toBeVisible({
      timeout: 60_000,
    });

    // The sheet lists /goal under Typed commands, found by its own search.
    await composer.click();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("keyboard");
    await page.getByRole("option", { name: /^Keyboard shortcuts/ }).click();
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByRole("heading", { name: "Typed commands" })).toBeVisible();
    await expect(sheet.getByText("/goal", { exact: true })).toBeVisible();
    await sheet.getByLabel("Search shortcuts").fill("goal");
    await expect(sheet.getByText("/goal", { exact: true })).toBeVisible();
    await expectStylesLoaded(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1261-sheet-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1261-sheet-dark.png") });
    await setTheme(page, false);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1261: the palette's goal commands show, pause, resume and drop the goal, and report it in the header",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
      expectApp: false,
    });
    await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 60_000 });
    const composer = await startChat(page);
    await composer.fill("/goal Keep the docs current");
    await sendTyped(page);
    await expect(statusLine(page, "Goal set: Keep the docs current. Status: Active.")).toBeVisible({
      timeout: 60_000,
    });

    await runPaletteGoal(page, composer, "Show goal");
    await expect(statusLine(page, "Goal: Keep the docs current. Status: Active.")).toBeVisible({
      timeout: 60_000,
    });

    await runPaletteGoal(page, composer, "Pause goal");
    await expect(
      statusLine(page, "Goal paused: Keep the docs current. Status: Paused."),
    ).toBeVisible({ timeout: 60_000 });

    await runPaletteGoal(page, composer, "Resume goal");
    await expect(
      statusLine(page, "Goal resumed: Keep the docs current. Status: Active."),
    ).toBeVisible({ timeout: 60_000 });

    await expectStylesLoaded(page);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1261-palette-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    // A sidebar's visibility changes only when its closing transition ends, so hidden means the capture is settled.
    await expect(page.locator('[data-shell-sidebar="right"]')).toBeHidden();
    await expect(page.locator('[data-shell-sidebar="left"]')).toBeHidden();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1261-palette-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    await runPaletteGoal(page, composer, "Drop goal");
    await expect(statusLine(page, /Goal dropped/)).toBeVisible({
      timeout: 60_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);
