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

/**
 * Issue #1303 on real omp. While a message is queued during a streaming reply (a steer with Enter, a follow-up with
 * Ctrl+Enter), the queue lane sat in the composer's toolbar row beside the round Stop button. The lane took the row's
 * width, so the steer hint was squeezed to 0 px: its text ran under Stop and past the composer's edge. The lane now sits
 * on a row of its own under the controls, and the hint is shown whole or not at all. Checked at 1280 px (light and
 * dark), at 390 px and at 195 px (a 390 px phone at 200% zoom): no text under Stop, no text past the composer's border,
 * no sideways scroll, and the lane below the controls.
 */

const STEER = "steer one";
const FOLLOW = "follow one";
const HINT = "Enter steers · Ctrl+Enter queues";
/** Streams a reply for about a minute, so the turn is still open while both messages wait, even on a loaded machine. */
const LONG_RUN = "stream_steady please";
const PHONE = { width: 390, height: 844 } as const;
const PHONE_AT_200_PERCENT = { width: 195, height: 844 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;

realTest.setTimeout(420_000);

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
}

/** The composer's geometry while a steer and a follow-up wait in its queue. */
interface Composer {
  readonly card: Box;
  readonly toolbar: Box;
  readonly stop: Box;
  /** The queue lane's box, or null when no lane is drawn. */
  readonly queue: Box | null;
  /** Whether the steer hint is drawn at all (it has a box in the layout). */
  readonly hintShown: boolean;
  /** Whether the steer hint's text fits its own box (it is not squeezed). */
  readonly hintFits: boolean;
  /** Every text the composer draws, cut to what a person can see, with its box. */
  readonly texts: readonly { readonly text: string; readonly box: Box }[];
  readonly page: { readonly scrollWidth: number; readonly clientWidth: number };
}

/** Sends the long run and waits until the composer offers Stop; then queues a steer and a follow-up. */
async function queueSteerAndFollowUp(page: Page, composer: Locator): Promise<void> {
  await sendPrompt(composer, LONG_RUN);
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
    timeout: 120_000,
  });
  await composer.fill(STEER);
  await composer.press("Enter");
  const queue = page.getByRole("complementary", { name: "Queued messages" });
  await expect(
    queue.getByRole("region", { name: "Steering" }).getByText(STEER, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await composer.fill(FOLLOW);
  await composer.press("Control+Enter");
  await expect(
    queue.getByRole("region", { name: "After this turn" }).getByText(FOLLOW, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

async function measure(page: Page): Promise<Composer> {
  return page.evaluate(() => {
    const boxOf = (element: Element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const card = document.querySelector('[data-composer-card="true"]');
    const toolbar = document.querySelector('[data-composer-toolbar="true"]');
    const stop = document.querySelector('button[aria-label="Stop generating"]');
    const queue = document.querySelector('[data-surface="queue"]');
    const hint = document.querySelector('[data-composer-steer-hint="true"]');
    if (card === null || toolbar === null || stop === null) {
      throw new Error("the composer is not on the page");
    }
    const texts: Array<{ text: string; box: Box }> = [];
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (text === "") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        let left = rect.left;
        let right = rect.right;
        let top = rect.top;
        let bottom = rect.bottom;
        // A part clipped by an ancestor that hides its overflow is not drawn past that ancestor.
        for (let el = node.parentElement; el !== null && card.contains(el); el = el.parentElement) {
          if (["hidden", "clip", "auto", "scroll"].includes(getComputedStyle(el).overflowX)) {
            const clip = el.getBoundingClientRect();
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
        }
        if (rect.width > 0 && rect.height > 0 && right > left && bottom > top) {
          texts.push({ text, box: { left, right, top, bottom, width: right - left } });
        }
      }
    }
    return {
      card: boxOf(card),
      toolbar: boxOf(toolbar),
      stop: boxOf(stop),
      queue: queue !== null && queue.getClientRects().length > 0 ? boxOf(queue) : null,
      hintShown: hint !== null && hint.getClientRects().length > 0,
      hintFits: hint === null || hint.scrollWidth <= hint.clientWidth + 0.5,
      texts,
      page: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
    };
  });
}

/** Whether two boxes share any area, with half a pixel of tolerance for rounding. */
function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.right - 0.5 &&
    a.right > b.left + 0.5 &&
    a.top < b.bottom - 0.5 &&
    a.bottom > b.top + 0.5
  );
}

/** Nothing the composer draws is under Stop or past its border; the hint is whole; the lane sits under the controls. */
function expectNothingCovered(composer: Composer): void {
  const under = composer.texts
    .filter((text) => overlaps(text.box, composer.stop))
    .map((text) => text.text);
  expect(under, "no text runs under the Stop button").toEqual([]);
  const past = composer.texts
    .filter(
      (text) =>
        text.box.left < composer.card.left - 0.5 || text.box.right > composer.card.right + 0.5,
    )
    .map((text) => text.text);
  expect(past, "no text runs past the composer's border").toEqual([]);
  expect(composer.hintFits, "the steer hint is whole, not squeezed").toBe(true);
  expect(composer.page.scrollWidth, "no sideways scroll").toBeLessThanOrEqual(
    composer.page.clientWidth,
  );
  expect(composer.queue, "the queue lane is drawn").not.toBeNull();
  expect(composer.queue?.top ?? 0, "the queue lane sits under the controls").toBeGreaterThanOrEqual(
    composer.toolbar.bottom - 0.5,
  );
}

realTest(
  "at 1280 px, a queued steer and follow-up leave the steer hint whole and cover nothing",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);
    await queueSteerAndFollowUp(page, composer);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1303-queued-light.png") });
    const measured = await measure(page);
    expect(measured.hintShown, "the steer hint is shown at 1280 px").toBe(true);
    expectNothingCovered(measured);
    await expect(page.getByText(HINT, { exact: true })).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "in dark, the same queued messages at 1280 px leave the steer hint whole and cover nothing",
  async ({ realApp }) => {
    const page = await realApp.open({
      beforeLoad: (openPage) =>
        openPage.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);
    await queueSteerAndFollowUp(page, composer);
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1303-queued-dark.png") });
    const measured = await measure(page);
    expect(measured.hintShown, "the steer hint is shown at 1280 px").toBe(true);
    expectNothingCovered(measured);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "at 390 px, the queued messages fit the composer, the hint is hidden and nothing runs past the border",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    // The width changes before the message is sent: the session list narrows away at a phone's width.
    await page.setViewportSize(PHONE);
    await queueSteerAndFollowUp(page, composer);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1303-queued-390-light.png") });
    const measured = await measure(page);
    expect(measured.hintShown, "the steer hint is hidden in a narrow composer").toBe(false);
    expectNothingCovered(measured);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "at 200% zoom (a 195 px window), the queued messages fit the composer and nothing runs past the border",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.setViewportSize(PHONE_AT_200_PERCENT);
    await queueSteerAndFollowUp(page, composer);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1303-queued-200-light.png") });
    const measured = await measure(page);
    expect(measured.hintShown, "the steer hint is hidden in a narrow composer").toBe(false);
    expectNothingCovered(measured);
    expect(realApp.problems).toEqual([]);
  },
);
