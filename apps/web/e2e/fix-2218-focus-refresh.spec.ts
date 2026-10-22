import type { Locator, Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

declare global {
  interface Window {
    /** The running row's option, focused the moment the list drew it (see `focusRunningRowWhenDrawn`). */
    __focusedRow2218?: HTMLElement;
  }
}

/**
 * Puts keyboard focus on the open chat's row the moment the list draws it as a running row: a chat whose session file
 * is not listed yet. The list then replaces that row with the listed row when the turn ends.
 */
async function focusRunningRowWhenDrawn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const focusOnce = (): void => {
      if (window.__focusedRow2218 !== undefined) return;
      const option = document.querySelector<HTMLElement>(
        '[data-slot="r1-running-row"] [role="option"]',
      );
      if (option === null) return;
      option.focus();
      if (document.activeElement === option) window.__focusedRow2218 = option;
    };
    new MutationObserver(focusOnce).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-open"],
    });
    focusOnce();
  });
}

/** True when keyboard focus is on an option of the open chat's listed row. */
async function focusIsOnOpenChatRow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const row = active?.closest('[data-slot="r1-session-row"]');
    return (
      active?.getAttribute("role") === "option" && row?.getAttribute("data-selected") === "true"
    );
  });
}

/**
 * A new chat's first turn. The fake model streams its reasoning for about 14 s before the answer, so the turn lasts long
 * enough to focus the running row and to let the turn end while the focus is on it.
 */
async function focusThroughFirstTurn(
  page: Page,
  composer: Locator,
  openDrawer?: () => Promise<void>,
): Promise<void> {
  await focusRunningRowWhenDrawn(page);
  await sendPrompt(composer, "stream_reasoning keep the focus");
  // At 390 px a drawer covers the composer, so a drawer this check needs opens only after the prompt is sent.
  await openDrawer?.();
  await expect
    .poll(() => page.evaluate(() => window.__focusedRow2218 !== undefined), { timeout: 30_000 })
    .toBe(true);
  // The turn is over when its running marker leaves the list: the list has refreshed by then.
  await expect(page.locator('[data-slot="r1-session-running"]:visible')).toHaveCount(0, {
    timeout: 90_000,
  });
  await expect.poll(() => focusIsOnOpenChatRow(page), { timeout: 10_000 }).toBe(true);
}

realTest(
  "#2218 keeps focus on the open chat's row when its running row becomes its listed row (1280 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      const composer = await startChat(page);
      await focusThroughFirstTurn(page, composer);
    } finally {
      await page.close();
    }
  },
);

realTest(
  "#2218 keeps focus on the open chat's row in the 390 px drawer when its running row becomes its listed row",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    try {
      const composer = await startChat(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await focusThroughFirstTurn(page, composer, async () => {
        await page.getByRole("button", { name: "Show sessions sidebar" }).click();
        await expect(page.locator('nav[aria-label="Sessions"]')).toHaveAttribute(
          "data-open",
          "true",
        );
      });
    } finally {
      await page.close();
    }
  },
);
