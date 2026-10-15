import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1380, the part that reproduces on real omp. A saved shortcut preference that is not JSON leaves the app on
 * its default shortcuts, and only the keyboard shortcuts sheet said so. The header now says it when the app opens,
 * with the sheet still giving the reset. (The issue's example, Ctrl+G, cannot reject: its action never fails.)
 */

const NOTICE =
  "Could not load saved shortcuts, so the default shortcuts are in use. Open Keyboard shortcuts and choose Reset all.";
const NOTHING_QUEUED = "No queued message to bring back.";

function noticeOf(page: Page) {
  return page.getByRole("alert").filter({ hasText: NOTICE });
}

// Two messages read at once only if neither covers the other: their vertical extents must not meet.
async function expectStacked(first: Locator, second: Locator): Promise<void> {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  if (a === null || b === null) return;
  expect(a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
}

realTest(
  "a saved shortcut preference that cannot be read is said in the header when the app opens, in light",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp.app.shortcuts", "{not json")),
    });
    await expect(noticeOf(page)).toBeVisible();
    await expect(page.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1380-preference-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("the same header notice reads the same in dark", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.addInitScript(() =>
        window.localStorage.setItem("omp.app.shortcuts", "{not json"),
      );
      await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
    },
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(noticeOf(page)).toBeVisible();
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1380-preference-dark.png") });
  expect(realApp.problems).toEqual([]);
});

realTest("the header notice stays readable at 390 px", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp.app.shortcuts", "{not json")),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(noticeOf(page)).toBeVisible();
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1380-preference-narrow.png") });
  expect(realApp.problems).toEqual([]);
});

realTest(
  "with a chat open, the notice and a command message read at once, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp.app.shortcuts", "{not json")),
    });
    const composer = await startChat(page);
    await expect(noticeOf(page)).toBeVisible();
    // Alt+Up on an empty queue reports that nothing is queued: a command message in the same header.
    await composer.focus();
    await page.keyboard.press("Alt+ArrowUp");
    const message = page.getByRole("status").filter({ hasText: NOTHING_QUEUED });
    await expect(message).toBeVisible();
    await expect(noticeOf(page)).toBeVisible();
    await expectStacked(noticeOf(page), message);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1380-preference-chat-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "with a chat open, the notice and a command message read at once, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(() =>
          window.localStorage.setItem("omp.app.shortcuts", "{not json"),
        );
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
      },
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const composer = await startChat(page);
    await expect(noticeOf(page)).toBeVisible();
    await composer.focus();
    await page.keyboard.press("Alt+ArrowUp");
    const message = page.getByRole("status").filter({ hasText: NOTHING_QUEUED });
    await expect(message).toBeVisible();
    await expect(noticeOf(page)).toBeVisible();
    await expectStacked(noticeOf(page), message);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1380-preference-chat-dark.png") });
    expect(realApp.problems).toEqual([]);
  },
);
