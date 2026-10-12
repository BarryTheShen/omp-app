import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #1200 on a model that has slow mode. omp 18.8.9 reports Claude Haiku 4.5 as supporting it. The saved chat records
 * that model and the harness runs omp without a forced model, so omp restores it when the chat opens (as
 * fix-1153-saved-model.spec.ts relies on). Both Slow mode buttons are live, turning it on shows On, and omp still says
 * On after the page reloads. No prompt is sent.
 */

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const at = Date.UTC(2026, 9, 3, 11, 59, 0);

realTest.use({
  defaultModel: false,
  seedEntries: {
    entries: [
      { type: "model_change", model: "anthropic/claude-haiku-4-5" },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello from the slow mode chat" }],
          timestamp: at,
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the slow mode answer" }],
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage,
          stopReason: "stop",
          timestamp: at + 1000,
        },
      },
    ],
  },
});

async function openDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Execution modes" }).click();
  const dialog = page.getByRole("dialog", { name: "Execution modes" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function slowButton(dialog: Locator, name: "Turn on" | "Turn off"): Locator {
  return dialog.getByRole("group", { name: "Slow mode controls" }).getByRole("button", { name });
}

/** The chosen button is pressed once omp has answered; the other can be pressed. A chosen button is disabled on purpose. */
async function expectSlow(dialog: Locator, on: boolean): Promise<void> {
  const chosen = slowButton(dialog, on ? "Turn on" : "Turn off");
  const other = slowButton(dialog, on ? "Turn off" : "Turn on");
  await expect(chosen).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
  await expect(other).toHaveAttribute("aria-pressed", "false");
  await expect(other).toBeEnabled();
}

async function capture(page: Page, dialog: Locator, name: string): Promise<void> {
  await dialog.getByRole("group", { name: "Slow mode controls" }).scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await waitForFiniteAnimations(page);
  await dialog.screenshot({ animations: "disabled", path: join(screenshots, name) });
}

/** The session list's first chat is the saved one: it opens from the list and shows its answer. */
async function openSavedChat(page: Page): Promise<void> {
  const row = page.getByRole("listbox", { name: "Session list" }).getByRole("option").first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await expect(
    page.getByRole("region", { name: "Conversation transcript" }).getByText("the slow mode answer"),
  ).toBeVisible({ timeout: 60_000 });
}

realTest(
  "#1200 real omp on a model with slow mode: turning Slow mode on shows On, and omp still says On after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => {
          if (window.localStorage.getItem("omp-app.theme") === null)
            window.localStorage.setItem("omp-app.theme", "light");
        }),
    });
    await openSavedChat(page);

    const before = await openDialog(page);
    await expectSlow(before, false);
    await capture(page, before, "fix-1200-slow-off-light.png");
    await slowButton(before, "Turn on").click();
    await expectSlow(before, true);
    await before.getByRole("button", { name: "Done" }).click();
    await expect(before).toBeHidden();

    await page.reload();
    await openSavedChat(page);
    const after = await openDialog(page);
    await expectSlow(after, true);
    await expect(after.getByRole("status").filter({ hasText: /^On$/ })).toHaveCount(1);
    await capture(page, after, "fix-1200-slow-on-light.png");
    await after.getByRole("button", { name: "Done" }).click();
    await expect(after).toBeHidden();

    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    await openSavedChat(page);
    const dark = await openDialog(page);
    await expectSlow(dark, true);
    await capture(page, dark, "fix-1200-slow-on-dark.png");
    await dark.getByRole("button", { name: "Done" }).click();
    await expect(dark).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    const narrow = await openDialog(page);
    await expectSlow(narrow, true);
    await capture(page, narrow, "fix-1200-slow-on-narrow.png");
    expect(realApp.problems).toEqual([]);
  },
);
