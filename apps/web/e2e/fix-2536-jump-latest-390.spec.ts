import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots } from "./real-omp";

/*
 * Issue 2536 (P1): at 390 px a reader away from the newest message sees "Jump to latest" laid over the last line of the
 * transcript. Red on main: the button floats 44 px above the thread footer and covers the line that sits there. Green with
 * the fix: the button takes its own row of the footer, so no transcript line is drawn under it, at 390 px and at 1280 px,
 * in light and dark.
 */

realTest.setTimeout(300_000);

const TURNS = 30;
const WHEN = Date.UTC(2026, 9, 1);
const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const BASE = {
  api: "openai-completions",
  provider: "fake",
  model: "fake-model",
  usage: USAGE,
  timestamp: WHEN,
};
const PARAGRAPH =
  "This answer runs over several full-width lines at a phone width, so a line of it sits just above the footer when the reader is away from the newest message. ";

/** Thirty question and answer pairs; each answer is three paragraphs, so its lines run the full width at 390 px. */
function longAnswerEntries(): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    entries.push({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: `Long answers chat turn ${turn}` }],
        timestamp: WHEN,
      },
    });
    entries.push({
      type: "message",
      message: {
        ...BASE,
        role: "assistant",
        content: [{ type: "text", text: `Answer ${turn}. ${PARAGRAPH.repeat(3)}` }],
        stopReason: "stop",
      },
    });
  }
  return entries;
}

realTest.use({ seedEntries: { entries: longAnswerEntries() } });

const VIEWPORT = '[data-slot="u1-thread-viewport"]';
/** Where the old button sat: 44 px above the footer's top edge and 32 px tall, so its centre was 28 px above it. */
const OLD_BUTTON_CENTRE_ABOVE_FOOTER = 28;
/** The empty left gutter: a wheel there scrolls the transcript, not a nested tool card. */
const GUTTER = { x: 20, y: 300 };

interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

interface Line extends Box {
  readonly text: string;
}

interface Measure {
  readonly footerTop: number;
  readonly button: Box | null;
  readonly lines: readonly Line[];
}

/** The transcript's text lines above the footer, and the Jump button's box, in viewport pixels. Runs in the page. */
function measure(): Measure | null {
  const viewport = document.querySelector<HTMLElement>('[data-slot="u1-thread-viewport"]');
  const footer = document.querySelector<HTMLElement>('[data-slot="u1-thread-footer"]');
  if (!viewport || !footer) return null;
  const view = viewport.getBoundingClientRect();
  const footerTop = footer.getBoundingClientRect().top;
  const lines: Line[] = [];
  const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? "";
    if (text === "" || node.parentElement?.closest('[data-slot="u1-thread-footer"]')) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width < 40 || rect.top < view.top || rect.bottom > footerTop) continue;
      lines.push({
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        text: text.slice(0, 40),
      });
    }
  }
  const button = document.querySelector<HTMLElement>('[data-slot="u1-scroll-to-bottom"]');
  const box = button?.getBoundingClientRect();
  return {
    footerTop,
    button: box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right } : null,
    lines,
  };
}

/** Whether two boxes share any pixel. */
function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Waits until the transcript's scroll position and height stop changing (rows far away are drawn lazily). */
async function settle(page: Page): Promise<void> {
  let previous = "";
  let same = 0;
  await expect
    .poll(
      async () => {
        const now = await page
          .locator(VIEWPORT)
          .evaluate((element) => `${Math.round(element.scrollTop)}/${element.scrollHeight}`);
        same = now === previous ? same + 1 : 0;
        previous = now;
        return same;
      },
      { intervals: [300], timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

/** Scrolls the transcript so that its full-width line nearest the footer sits where the old button was. */
async function putLastLineWhereOldButtonWas(page: Page): Promise<void> {
  const now = await page.evaluate(measure);
  if (now === null) throw new Error("The transcript or its footer was not found.");
  const target = [...now.lines]
    .filter((line) => line.right - line.left > 200)
    .sort((a, b) => b.bottom - a.bottom)[0];
  if (target === undefined) throw new Error("No full-width transcript line sits above the footer.");
  const centre = (target.top + target.bottom) / 2;
  const wanted = now.footerTop - OLD_BUTTON_CENTRE_ABOVE_FOOTER;
  await page.locator(VIEWPORT).evaluate((element, pixels) => {
    element.scrollTop += pixels;
  }, centre - wanted);
}

realTest(
  "real omp: at 390 px and 1280 px, in light and dark, Jump to latest covers no line of the transcript (issue 2536)",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /Long answers chat turn 0/ })
      .click();
    await expect(page.getByText(/^Answer 29\./)).toBeAttached({ timeout: 90_000 });
    const jump = page.getByRole("button", { name: "Jump to latest message" });
    await mkdir(screenshots, { recursive: true });
    for (const shot of [
      { name: "390-light", width: 390, height: 844, dark: false },
      { name: "390-dark", width: 390, height: 844, dark: true },
      { name: "1280-light", width: 1280, height: 900, dark: false },
      { name: "1280-dark", width: 1280, height: 900, dark: true },
    ]) {
      await page.setViewportSize({ width: shot.width, height: shot.height });
      await page.emulateMedia({ colorScheme: shot.dark ? "dark" : "light" });
      await settle(page);
      // The newest message first, then three notches of the wheel up: a reader away from the bottom.
      await page.locator(VIEWPORT).evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await settle(page);
      await page.locator(VIEWPORT).hover({ position: GUTTER });
      for (let notch = 0; notch < 3; notch += 1) await page.mouse.wheel(0, -100);
      await expect(jump).toBeVisible();
      await settle(page);
      // Put a full-width line where the old button sat, so the button would have covered it on main.
      await putLastLineWhereOldButtonWas(page);
      await settle(page);
      const now = await page.evaluate(measure);
      if (now === null || now.button === null)
        throw new Error(`${shot.name}: the transcript or the button was not found.`);
      const button = now.button;
      const underOldButton = now.lines.filter((line) => {
        const centre = (line.top + line.bottom) / 2;
        return (
          centre >= now.footerTop - 44 &&
          centre <= now.footerTop - 12 &&
          line.right - line.left > 200
        );
      });
      expect(underOldButton.length).toBeGreaterThan(0);
      const covered = now.lines.filter((line) => overlaps(line, button));
      expect(covered).toEqual([]);
      await page.screenshot({ path: join(screenshots, `fix-2536-${shot.name}.png`) });
    }
    expect(realApp.problems).toEqual([]);
  },
);
