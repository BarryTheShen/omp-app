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

/** One of the composer's input mode buttons: Prompt, Bash or Python. */
function modeButton(page: Page, name: string): Locator {
  return page.getByRole("group", { name: "Input mode" }).getByRole("button", { name, exact: true });
}

/** The conversation's messages: a sent message would show here, so none may after Escape. */
function userBubbles(page: Page): Locator {
  return page
    .getByRole("region", { name: "Conversation transcript" })
    .locator('[data-message-surface="user-bubble"]');
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "#821: Escape in bash mode returns the composer to Prompt and keeps the text",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await composer.pressSequentially("!some text");
    await expect(modeButton(page, "Bash")).toHaveAttribute("aria-pressed", "true");
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-821-bash-light.png") });

    await composer.press("Escape");
    await expect(composer).toHaveValue("some text");
    await expect(modeButton(page, "Prompt")).toHaveAttribute("aria-pressed", "true");
    await expect(modeButton(page, "Bash")).toHaveAttribute("aria-pressed", "false");
    await expect(userBubbles(page)).toHaveCount(0);
    await expect(composer).toBeFocused();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-821-prompt-light.png") });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toHaveValue("some text");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-821-prompt-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("#821: the Escape exit in dark theme", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  await mkdir(screenshots, { recursive: true });
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const composer = await startChat(page);
  await composer.pressSequentially("!some text");
  await expect(modeButton(page, "Bash")).toHaveAttribute("aria-pressed", "true");
  await composer.press("Escape");
  await expect(composer).toHaveValue("some text");
  await expect(modeButton(page, "Prompt")).toHaveAttribute("aria-pressed", "true");
  await expectStylesLoaded(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-821-prompt-dark.png") });
  expect(realApp.problems).toEqual([]);
});

realTest(
  "#821: while a turn runs, one Escape stops it and keeps bash mode; the next Escape leaves bash mode",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    // The fake model answers "long_probe_child" with a shell command that runs for 60 seconds.
    await sendPrompt(composer, "please run long_probe_child");
    const stop = page.getByRole("button", { name: "Stop generating" });
    await expect(stop).toBeVisible({ timeout: 60_000 });
    await composer.pressSequentially("!some text");
    await expect(modeButton(page, "Bash")).toHaveAttribute("aria-pressed", "true");

    await composer.press("Escape");
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
    await expect(composer).toHaveValue("!some text");
    await expect(modeButton(page, "Bash")).toHaveAttribute("aria-pressed", "true");
    await expect(composer).toBeFocused();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-821-stopped-bash-light.png") });

    await composer.press("Escape");
    await expect(composer).toHaveValue("some text");
    await expect(modeButton(page, "Prompt")).toHaveAttribute("aria-pressed", "true");
    expect(realApp.problems).toEqual([]);
  },
);
