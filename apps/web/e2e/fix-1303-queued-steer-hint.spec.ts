import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  type RealApp,
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
 * on a row of its own above the composer (#2316). The steer hint is the editor's placeholder, not a toolbar item. Checked at 1280 px (light and
 * dark), at 390 px and at 195 px (a 390 px phone at 200% zoom): no text under Stop, no text past the composer's border,
 * no sideways scroll, and the lane above the composer.
 */

const STEER = "steer one";
const FOLLOW = "follow one";
const HINT = "Enter steers · Ctrl+Enter queues";
/** Streams a reply for about a minute, so the turn is still open while both messages wait, even on a loaded machine. */
const LONG_RUN = "stream_steady please";
const PHONE = { width: 390, height: 844 } as const;
const PHONE_AT_200_PERCENT = { width: 195, height: 844 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;
const MODES = "Execution modes";
/** Thirty characters: a long model name in the composer's model pill. */
const LONG_MODEL = "Claude Haiku 5.5 Extended Mode";

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

/** Nothing the composer draws is under Stop or past its border, and the lane sits above the composer. */
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
  expect(composer.page.scrollWidth, "no sideways scroll").toBeLessThanOrEqual(
    composer.page.clientWidth,
  );
  expect(composer.queue, "the queue lane is drawn").not.toBeNull();
  expect(composer.queue?.bottom ?? 0, "the queue lane sits above the composer").toBeLessThanOrEqual(
    composer.card.top + 0.5,
  );
}

realTest(
  "at 1280 px, a queued steer and follow-up leave the steer placeholder on the editor and cover nothing",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);
    await queueSteerAndFollowUp(page, composer);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1303-queued-light.png") });
    const measured = await measure(page);
    await expect(composer).toHaveAttribute("placeholder", HINT);
    expectNothingCovered(measured);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "in dark, the same queued messages at 1280 px leave the steer placeholder on the editor and cover nothing",
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
    await expect(composer).toHaveAttribute("placeholder", HINT);
    expectNothingCovered(measured);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "at 390 px, the queued messages fit the composer and nothing runs past the border",
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
    await expect(composer).toHaveAttribute("placeholder", HINT);
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
    await expect(composer).toHaveAttribute("placeholder", HINT);
    expectNothingCovered(measured);
    expect(realApp.problems).toEqual([]);
  },
);

/** The Execution modes button's label and icon. The button's name stays "Execution modes" in every state. */
function executionModes(page: Page): { readonly label: Locator; readonly icon: Locator } {
  const button = page.getByRole("button", { name: MODES, exact: true });
  return { label: button.getByText(MODES, { exact: true }), icon: button.locator("svg") };
}

/** Puts `label` in the model pill: its first text node takes it and the others are emptied, so React keeps its nodes. */
async function setModelPillText(page: Page, label: string): Promise<void> {
  await page.evaluate((text) => {
    const pill = document.querySelector<HTMLElement>(
      '[data-composer-toolbar="true"] button[aria-label^="Model:"]',
    );
    if (pill === null) throw new Error("The model pill is missing");
    const walker = document.createTreeWalker(pill, NodeFilter.SHOW_TEXT);
    let placed = false;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.nodeValue ?? "").trim() === "") continue;
      node.nodeValue = placed ? "" : text;
      placed = true;
    }
    if (!placed) throw new Error("The model pill has no text to replace");
  }, label);
}

interface ToolbarFit {
  readonly pillText: string;
  readonly pillFits: boolean;
  readonly rowOverflows: boolean;
  /** The card's width, and the toolbar's content width: its box less the row's 8 px padding on each side. */
  readonly cardWidth: number;
  readonly contentWidth: number;
  readonly threadWidth: string;
  /** The text of each visible text element in the toolbar that hides its overflow and overflows it. */
  readonly clipped: readonly string[];
}

/** Whether the composer toolbar overflows or clips visible text, and the widths it is laid out in. */
async function toolbarFit(page: Page): Promise<ToolbarFit> {
  return page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-composer-toolbar="true"]');
    const pill = row?.querySelector<HTMLElement>('button[aria-label^="Model:"]') ?? null;
    if (row === null || pill === null)
      throw new Error("The composer toolbar or its model pill is missing");
    const clipped = Array.from(row.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        // Icons are SVG, and the screen-reader-only texts are 1 px wide on purpose: neither is visible text.
        if (element instanceof SVGElement || element.clientWidth <= 1) return false;
        const { overflowX } = getComputedStyle(element);
        const hasText = Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
        );
        const overflowHidden = overflowX === "hidden" || overflowX === "clip";
        return hasText && overflowHidden && element.scrollWidth > element.clientWidth + 0.5;
      })
      .map((element) => (element.textContent ?? "").trim().slice(0, 40));
    return {
      pillText: (pill.textContent ?? "").replace(/\s+/g, " ").trim(),
      pillFits: pill.scrollWidth <= pill.clientWidth + 0.5,
      rowOverflows: row.scrollWidth > row.clientWidth + 0.5,
      cardWidth: row.parentElement?.clientWidth ?? 0,
      contentWidth: row.clientWidth - 16,
      threadWidth: getComputedStyle(document.documentElement)
        .getPropertyValue("--layout-thread-width")
        .trim(),
      clipped,
    };
  });
}

interface ModesShot {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly dark: boolean;
}

/**
 * The Execution modes button around a reply: the label shows from 768 px and the icon below, before, during and after
 * the reply. The steer hint is the editor's placeholder, so nothing in the toolbar changes while the reply streams.
 */
async function modesAroundReply(realApp: RealApp, shot: ModesShot): Promise<void> {
  const page = shot.dark
    ? await realApp.open({
        beforeLoad: (openedPage) =>
          openedPage.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
      })
    : await realApp.open();
  await page.setViewportSize(DESKTOP);
  const composer = await startChat(page);
  await page.setViewportSize({ width: shot.width, height: shot.height });
  const wide = shot.width >= 768;
  const modes = executionModes(page);
  const stop = page.getByRole("button", { name: "Stop generating" });
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  if (wide) {
    await expect(modes.label, "the label shows before a reply").toBeVisible();
    await expect(modes.icon).toBeHidden();
  } else {
    await expect(modes.label).toBeHidden();
    await expect(modes.icon).toBeVisible();
  }
  await page.screenshot({ path: join(screenshots, `fix-1303-modes-${shot.name}-idle.png`) });

  await sendPrompt(composer, LONG_RUN);
  await expect(stop).toBeVisible({ timeout: 120_000 });
  if (wide) {
    await expect(modes.label, "the label stays while a reply streams").toBeVisible();
    await expect(modes.icon).toBeHidden();
  } else {
    await expect(modes.label).toBeHidden();
    await expect(modes.icon).toBeVisible();
  }
  await expect(composer, "the steer placeholder shows while a reply streams").toHaveAttribute(
    "placeholder",
    HINT,
  );
  await expect(page.getByRole("button", { name: MODES, exact: true })).toBeVisible();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, `fix-1303-modes-${shot.name}-streaming.png`) });

  await stop.click();
  await expect(stop).toBeHidden({ timeout: 30_000 });
  if (wide) {
    await expect(modes.label, "the label is back after the reply").toBeVisible();
    await expect(modes.icon).toBeHidden();
  } else {
    await expect(modes.label).toBeHidden();
    await expect(modes.icon).toBeVisible();
  }
  expect(realApp.problems).toEqual([]);
}

realTest(
  "at 1280 px in light, the Execution modes label shows before, during and after a reply",
  async ({ realApp }) => {
    await modesAroundReply(realApp, { name: "1280-light", width: 1280, height: 800, dark: false });
  },
);

realTest(
  "at 1280 px in dark, the Execution modes label shows before, during and after a reply",
  async ({ realApp }) => {
    await modesAroundReply(realApp, { name: "1280-dark", width: 1280, height: 800, dark: true });
  },
);

realTest(
  "at 390 px in light, the Execution modes button is an icon before, during and after a reply",
  async ({ realApp }) => {
    await modesAroundReply(realApp, { name: "390-light", width: 390, height: 844, dark: false });
  },
);

realTest(
  "at 390 px in dark, the Execution modes button is an icon before, during and after a reply",
  async ({ realApp }) => {
    await modesAroundReply(realApp, { name: "390-dark", width: 390, height: 844, dark: true });
  },
);

realTest(
  "with a 30-character model label at 1280 px, the model label stays whole and nothing overflows or clips",
  async ({ realApp }) => {
    expect(LONG_MODEL).toHaveLength(30);
    const page = await realApp.open();
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);
    await queueSteerAndFollowUp(page, composer);
    await setModelPillText(page, LONG_MODEL);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1303-wrap-1280-light-streaming.png") });
    const fit = await toolbarFit(page);
    const measured = await measure(page);
    expectNothingCovered(measured);
    await expect(executionModes(page).label).toBeVisible();
    await expect(executionModes(page).icon).toBeHidden();
    expect(fit.pillText, "the model label is whole").toBe(LONG_MODEL);
    expect(fit.pillFits, "the model pill does not clip its label").toBe(true);
    expect(fit.rowOverflows, "the toolbar row does not overflow").toBe(false);
    expect(
      fit.clipped,
      `visible text in the toolbar is clipped: ${fit.clipped.join(" | ")}`,
    ).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "with a 30-character model label at the 38 rem toolbar width, nothing overflows or clips while a reply streams",
  async ({ realApp }) => {
    expect(LONG_MODEL).toHaveLength(30);
    const page = await realApp.open();
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);
    // The column is 42 rem plus 2 px: the card's 1 px borders leave its toolbar's content exactly 38 rem (608 px) wide.
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--layout-thread-width", "calc(42rem + 2px)"),
    );
    await queueSteerAndFollowUp(page, composer);
    await setModelPillText(page, LONG_MODEL);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1303-wrap-608-light-streaming.png") });
    const fit = await toolbarFit(page);
    const measured = await measure(page);
    expectNothingCovered(measured);
    await expect(executionModes(page).label).toBeVisible();
    await expect(executionModes(page).icon).toBeHidden();
    expect(fit.contentWidth, "the toolbar's content is 38 rem wide").toBe(608);
    expect(fit.pillText, "the model label is whole").toBe(LONG_MODEL);
    expect(fit.pillFits, "the model pill does not clip its label").toBe(true);
    expect(fit.rowOverflows, "the toolbar row does not overflow").toBe(false);
    expect(
      fit.clipped,
      `visible text in the toolbar is clipped: ${fit.clipped.join(" | ")}`,
    ).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);
