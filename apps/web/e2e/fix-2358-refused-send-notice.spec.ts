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

const TEXT = "keep this message";
const NOTICE = "It's in the message box of a new chat";

/**
 * A later New chat starts only after the first message has been admitted to the chat that was opening.
 */
async function firstSendBeforeNextNewChat(page: Page): Promise<Locator> {
  const first = await startChat(page);
  await sendPrompt(first, "first chat");
  await expect(
    page.locator('[data-slot="u1-message-row"][data-role="assistant"]').last(),
  ).toContainText("pong", { timeout: 90_000 });
  const composer = await startChat(page);
  await sendPrompt(composer, TEXT);
  const next = await startChat(page);
  await expect(page.getByText(NOTICE, { exact: false })).toHaveCount(0);
  await expect(page.locator('[data-empty-chat="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(next).toHaveValue("");
  return next;
}

/** The shell has a painted background once its styles load (the same check app.spec.ts makes). */
async function expectShellPainted(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}
async function expectEmptyNewChatRemains(page: Page): Promise<void> {
  const emptyChat = page.locator('[data-empty-chat="true"]');
  const firstSendRow = page.locator('[data-slot="r1-session-row"]').filter({ hasText: TEXT });
  await expect(emptyChat).toBeVisible();
  await expect(firstSendRow).toHaveAttribute("data-selected", "false");
  await page.waitForTimeout(3000);
  await expect(emptyChat).toBeVisible();
  await expect(firstSendRow).toHaveAttribute("data-selected", "false");
}

realTest(
  "a first send reaches its New chat before another New chat starts, in light and at 390 px",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await firstSendBeforeNextNewChat(page);
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expectShellPainted(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2343-first-send-light.png"),
      fullPage: true,
    });
    // The next chat stays empty at phone width too.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-empty-chat="true"]')).toBeVisible();
    await expectShellPainted(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2343-first-send-narrow.png"),
      fullPage: true,
    });
    await expectEmptyNewChatRemains(page);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a first send reaches its New chat before another New chat starts, in dark",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await firstSendBeforeNextNewChat(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectShellPainted(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-2343-first-send-dark.png"),
      fullPage: true,
    });
    await expectEmptyNewChatRemains(page);
    expect(realApp.problems).toEqual([]);
  },
);
