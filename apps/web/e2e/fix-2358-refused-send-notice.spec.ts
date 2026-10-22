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
 * A send made in a New chat that has not opened yet is refused when the person starts another New chat at once. The
 * notice says where the text went, and the text is in the message box of the new chat (#2358, under #2343). An earlier
 * chat is answered first, as in the probe that reproduces it: a first chat's send can otherwise open before the next
 * New chat starts.
 */
async function refusedSendInNewChat(page: Page): Promise<Locator> {
  const first = await startChat(page);
  await sendPrompt(first, "first chat");
  await expect(
    page.locator('[data-slot="u1-message-row"][data-role="assistant"]').last(),
  ).toContainText("pong", { timeout: 90_000 });
  const composer = await startChat(page);
  await sendPrompt(composer, TEXT);
  const next = await startChat(page);
  await expect(page.getByText(NOTICE, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  // The third chat is on screen and empty, so the box that holds the text is that chat's.
  await expect(page.locator('[data-empty-chat="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(next).toHaveValue(TEXT);
  return next;
}

/** The shell has a painted background once its styles load (the same check app.spec.ts makes). */
async function expectShellPainted(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest("a refused send says where its text went, in light and at 390 px", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await refusedSendInNewChat(page);
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expectShellPainted(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-2358-refused-send-light.png"),
    fullPage: true,
  });
  // The same refused chat at phone width: the notice and the text are still there.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText(NOTICE, { exact: false }).first()).toBeVisible();
  await expectShellPainted(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-2358-refused-send-narrow.png"),
    fullPage: true,
  });
});

realTest("a refused send says where its text went, in dark", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await refusedSendInNewChat(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectShellPainted(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-2358-refused-send-dark.png"),
    fullPage: true,
  });
});
