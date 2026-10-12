import type { Page } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

/**
 * Motion (#1173, part 3, review of #1231): a dialog that fades out keeps keyboard focus where the reader can use it.
 * Keys typed right after the palette closes reach the composer, focus is never on the body while Settings leaves and
 * goes back to its button, and a window resize changes an open dialog's width in the first frame, not over 180 ms.
 */

/** Starts a per-frame log of where keyboard focus is; `body` means no element has it. */
async function startFocusLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: string[] = [];
    (window as unknown as { __focusLog: string[] }).__focusLog = log;
    const tick = (): void => {
      const active = document.activeElement;
      log.push(active === null || active === document.body ? "body" : active.tagName.toLowerCase());
      if (log.length < 5_000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function focusLogLength(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __focusLog: string[] }).__focusLog.length);
}

async function focusLogSince(page: Page, from: number): Promise<string[]> {
  return page.evaluate(
    (start) => (window as unknown as { __focusLog: string[] }).__focusLog.slice(start),
    from,
  );
}

realTest(
  "keys typed at once after the command palette closes reach the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.type("abc");
    await expect(composer).toHaveValue("abc", { timeout: 5_000 });
  },
);

realTest(
  "Settings closes with focus on its own button, never on the body",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    await settings.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await startFocusLog(page);
    const from = await focusLogLength(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await expect(settings).toBeFocused();
    const during = await focusLogSince(page, from);
    expect(during, "frames in which no element had focus while Settings left").not.toContain(
      "body",
    );
  },
);

realTest(
  "resizing the window changes an open dialog's width in the first frame",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    await page.setViewportSize({ width: 390, height: 844 });
    const widths = await dialog.evaluate(
      (element) =>
        new Promise<number[]>((resolve) => {
          const seen: number[] = [];
          const tick = (): void => {
            seen.push(Math.round(element.getBoundingClientRect().width));
            if (seen.length < 3) requestAnimationFrame(tick);
            else resolve(seen);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(widths[0], "the dialog's width in the first frame after the resize").toBeLessThanOrEqual(
      390,
    );
  },
);
