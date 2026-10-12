import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { sessionBucketName } from "../../../packages/server/src/modules/A1/sessions/paths";
import { expect, realTest, sendPrompt, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 1165. The chat "teleported": the message the reader was reading moved on screen without the reader scrolling.
 * The check is on that message. Its screen position may change only by the reader's own wheel steps, and by nothing
 * else: paging in earlier messages at the top, opening and closing a tool card above it, a reply that streams while
 * the reader is away, the turn's end (the history reloads), and a browser reload.
 *
 * The follow while a reply streams is issue 1183, checked by fix-1183-follow-stream.spec.ts.
 */

const TURNS = 64;
const RESULT_CHARACTERS = 75_000;
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

/**
 * A chat of 64 turns, each with one bash call whose output is 75 KB: 256 messages, more than the newest window holds,
 * so the earlier messages are paged in on request.
 */
function longChatEntries(): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (let turn = 0; turn < TURNS; turn += 1) {
    const callId = `call_${turn}`;
    entries.push({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: `Scroll chat turn ${turn}` }],
        timestamp: WHEN,
      },
    });
    entries.push({
      type: "message",
      message: {
        ...BASE,
        role: "assistant",
        content: [
          { type: "toolCall", id: callId, name: "bash", arguments: { command: `echo ${turn}` } },
        ],
        stopReason: "toolUse",
      },
    });
    entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "bash",
        content: [{ type: "text", text: `result ${turn}\n${"x".repeat(RESULT_CHARACTERS)}` }],
        isError: false,
        timestamp: WHEN,
      },
    });
    entries.push({
      type: "message",
      message: {
        ...BASE,
        role: "assistant",
        content: [{ type: "text", text: `Answer ${turn}` }],
        stopReason: "stop",
      },
    });
  }
  return entries;
}

realTest.use({ seedEntries: { entries: longChatEntries() } });

const VIEWPORT = '[data-slot="u1-thread-viewport"]';
/** The empty left gutter of the transcript: a wheel there scrolls the transcript, not a nested tool-card scroller. */
const GUTTER = { x: 20, y: 300 };
/** How far a row may move on screen beyond the reader's own scrolling. */
const TOLERANCE_PX = 1;

interface ReaderPlace {
  readonly label: string;
  /** The row's top edge on screen, from the top edge of the transcript; null when the row is gone. */
  readonly top: number | null;
  readonly scrollTop: number;
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

/** Opens the long chat at its newest message, where the transcript starts at the bottom. */
async function openLongChat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: /Scroll chat turn 0/ })
    .click();
  await expect(page.getByText("Answer 63", { exact: true })).toBeAttached({ timeout: 90_000 });
  await settle(page);
}

/** The message row at a fraction of the transcript's height: the reader's row. Null when none is there. */
async function readerRowAt(page: Page, fraction: number): Promise<string | null> {
  return page.evaluate(
    ({ selector, fraction }) => {
      const viewport = document.querySelector<HTMLElement>(selector);
      if (viewport === null) return null;
      const box = viewport.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height * fraction,
      );
      const row = hit?.closest<HTMLElement>("[data-message-id]");
      return row && viewport.contains(row) ? (row.dataset.messageId ?? null) : null;
    },
    { selector: VIEWPORT, fraction },
  );
}

/** Where a row sits on screen now, and where the transcript is scrolled. */
async function placeOf(page: Page, label: string, rowId: string): Promise<ReaderPlace> {
  return page.evaluate(
    async ({ selector, label, rowId }) => {
      // Two animation frames: each change's scroll event has run, and the layout has been painted before the place is read.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const viewport = document.querySelector<HTMLElement>(selector);
      if (viewport === null) throw new Error("no transcript");
      const row = Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id]")).find(
        (element) => element.dataset.messageId === rowId,
      );
      return {
        label,
        top:
          row === undefined
            ? null
            : Math.round(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
        scrollTop: Math.round(viewport.scrollTop),
      };
    },
    { selector: VIEWPORT, label, rowId },
  );
}

/** Asserts that the reader's row moved on screen by no more than the tolerance, with the trace in the failure. */
function expectStill(trace: readonly ReaderPlace[], before: ReaderPlace, after: ReaderPlace): void {
  const moved = before.top === null || after.top === null ? Number.NaN : after.top - before.top;
  expect(
    Math.abs(moved),
    `${after.label}: the reader's row moved ${moved}px on screen (trace: ${JSON.stringify(trace)})`,
  ).toBeLessThanOrEqual(TOLERANCE_PX);
}

/** Marks a message row for the layout sampler, under the name the sampler reports it by. */
async function markRow(page: Page, rowId: string, name: string): Promise<void> {
  await page.evaluate(
    ({ rowId, name }) => {
      const row = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]")).find(
        (element) => element.dataset.messageId === rowId,
      );
      row?.setAttribute("data-probe", name);
    },
    { rowId, name },
  );
}

/** Marks a locator for the layout sampler, under the name the sampler reports it by. */
async function markElement(target: Locator, name: string): Promise<void> {
  await target.evaluate((element, name) => element.setAttribute("data-probe", name), name);
}

/** The offsets the layout sampler reported for each marked element, by name. */
type OffsetSamples = Record<string, number[]>;

/**
 * Runs in the page, one frame at a time, until the page's stop flag is set or `maxMs` passes: for each marked element, the
 * whole-pixel offsets of its top edge from the top edge of the transcript, in the order they appeared. A frame that paints a
 * row in another place shows up as an extra offset. Self-contained: Playwright ships only this function's source.
 */
function sampleMarkedOffsetsInPage(options: {
  viewport: string;
  maxMs: number;
}): Promise<OffsetSamples> {
  return new Promise((resolve) => {
    delete document.documentElement.dataset.samplerStop;
    const started = performance.now();
    const seen: OffsetSamples = {};
    const frame = (): void => {
      const viewport = document.querySelector<HTMLElement>(options.viewport);
      if (viewport !== null) {
        const top = viewport.getBoundingClientRect().top;
        for (const marked of document.querySelectorAll<HTMLElement>("[data-probe]")) {
          const name = marked.dataset.probe ?? "";
          const offset = Math.round(marked.getBoundingClientRect().top - top);
          const values = seen[name] ?? [];
          values.push(offset);
          seen[name] = values;
        }
      }
      const stopped = document.documentElement.dataset.samplerStop === "1";
      if (!stopped && performance.now() - started < options.maxMs) requestAnimationFrame(frame);
      else resolve(seen);
    };
    frame();
  });
}

/** Ends the layout sampler that is running in the page. */
async function stopSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.samplerStop = "1";
  });
}

/**
 * The longest run of consecutive frames painted off the place the frames start on. A frame that is not drawn counts as off.
 * Issue 1165: a row may be off its place for at most two frames, and it must end on the place it started from.
 */
function offRunOf(frames: readonly number[]): number {
  const place = frames[0] ?? Number.NaN;
  let longest = 0;
  let run = 0;
  for (const offset of frames) {
    run = Math.abs(offset - place) <= TOLERANCE_PX ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** Whether a list of offsets only ever moves one way: a change made once, not back and forth. */
function movesOneWay(offsets: readonly number[]): boolean {
  let direction = 0;
  for (let index = 1; index < offsets.length; index += 1) {
    const step = Math.sign((offsets[index] ?? 0) - (offsets[index - 1] ?? 0));
    if (step === 0) continue;
    if (direction !== 0 && step !== direction) return false;
    direction = step;
  }
  return true;
}

/**
 * Scrolls a little at a time until a bash card's header is drawn in the view, on the given side of the reader's row (the
 * message in the middle of the view). Returns the card's index among the bash cards, and the reader's row.
 */
async function headerAroundReader(
  page: Page,
  side: "above" | "below",
): Promise<{ index: number; readerId: string }> {
  const viewport = page.locator(VIEWPORT);
  const headers = page.getByRole("button", { name: /^bash: / });
  // The chat opens at the bottom, where the view follows the newest message. A press holds a card only while the reader is
  // away from it, so the view moves up first, whichever side the card is on.
  await viewport.hover({ position: GUTTER });
  await page.mouse.wheel(0, -1_500);
  await settle(page);
  for (let step = 0; step < 80; step += 1) {
    const readerId = await readerRowAt(page, 0.5);
    const transcript = await viewport.boundingBox();
    if (readerId !== null && transcript !== null) {
      const count = await headers.count();
      for (let index = 0; index < count; index += 1) {
        const header = headers.nth(index);
        const relation = await header.evaluate((element, id) => {
          const row = element.closest("[data-message-id]");
          const reader = Array.from(document.querySelectorAll("[data-message-id]")).find(
            (candidate) => candidate.getAttribute("data-message-id") === id,
          );
          if (row === null || reader === undefined || row === reader) return "none";
          return (row.compareDocumentPosition(reader) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
            ? "above"
            : "below";
        }, readerId);
        if (relation !== side) continue;
        const box = await header.boundingBox();
        if (
          box !== null &&
          box.y >= transcript.y &&
          box.y + box.height <= transcript.y + transcript.height
        ) {
          return { index, readerId };
        }
      }
    }
    await viewport.hover({ position: GUTTER });
    await page.mouse.wheel(0, side === "above" ? -300 : 300);
    await settle(page);
  }
  throw new Error(`no bash card header is drawn ${side} the reader's row`);
}

/** Moves the pointer onto an element and presses the mouse button down and up on it, without scrolling the view. */
async function pressWithMouse(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("the element to press is not drawn");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

/**
 * Presses a card's header with the mouse to open it, sampling the marked header and reader row on every frame of the press and
 * of the settling after it. Returns the header, which the close press needs, and what was sampled.
 */
async function pressCardOpen(
  page: Page,
  index: number,
  readerId: string,
): Promise<{ header: Locator; opened: OffsetSamples }> {
  const header = page.getByRole("button", { name: /^bash: / }).nth(index);
  await markElement(header, "header");
  await markRow(page, readerId, "reader");
  const opening = page.evaluate(sampleMarkedOffsetsInPage, { viewport: VIEWPORT, maxMs: 60_000 });
  await pressWithMouse(page, header);
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await settle(page);
  await waitForFiniteAnimations(page);
  await stopSampling(page);
  return { header, opened: await opening };
}

/** Presses the same header again to close the card, sampling the marked header and reader row on every frame of the press. */
async function pressCardClose(page: Page, header: Locator): Promise<OffsetSamples> {
  const closing = page.evaluate(sampleMarkedOffsetsInPage, { viewport: VIEWPORT, maxMs: 60_000 });
  await pressWithMouse(page, header);
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await settle(page);
  await waitForFiniteAnimations(page);
  await stopSampling(page);
  return closing;
}

realTest(
  "real omp: paging in earlier messages leaves the reader's row in place",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    const page = await realApp.open();
    await openLongChat(page);
    const viewport = page.locator(VIEWPORT);
    const trace: ReaderPlace[] = [];

    // The reader scrolls to the top, where the "Show earlier messages" control is on screen.
    const earlier = page.getByRole("button", { name: /Show earlier messages/ });
    for (let step = 0; step < 60; step += 1) {
      const transcript = await viewport.boundingBox();
      const control = (await earlier.count()) > 0 ? await earlier.first().boundingBox() : null;
      if (
        transcript !== null &&
        control !== null &&
        control.y >= transcript.y &&
        control.y + control.height <= transcript.y + transcript.height
      ) {
        break;
      }
      await viewport.hover({ position: GUTTER });
      await page.mouse.wheel(0, -1_500);
      await page.waitForTimeout(150);
    }
    await settle(page);

    // Paging in: the older messages land above the reader's row.
    const pageRow = await readerRowAt(page, 0.5);
    expect(pageRow, "a message row is in the middle of the transcript").not.toBeNull();
    const pagedBefore = await placeOf(page, "before earlier messages", pageRow ?? "");
    trace.push(pagedBefore);
    const rowsBefore = await page.locator("[data-message-id]").count();
    // The reader's row, marked for the layout sampler: the older messages land above it, and no frame may paint it elsewhere.
    await markRow(page, pageRow ?? "", "reader");
    const paging = page.evaluate(sampleMarkedOffsetsInPage, { viewport: VIEWPORT, maxMs: 120_000 });
    await earlier.click();
    await expect
      .poll(async () => page.locator("[data-message-id]").count(), { timeout: 60_000 })
      .toBeGreaterThan(rowsBefore);
    await settle(page);
    await stopSampling(page);
    const pagedOffsets = await paging;
    const pagedAfter = await placeOf(page, "after earlier messages", pageRow ?? "");
    trace.push(pagedAfter);
    expectStill(trace, pagedBefore, pagedAfter);
    expect(
      offRunOf(pagedOffsets.reader ?? []),
      `the reader's row was painted in other places while the older messages landed (offsets: ${JSON.stringify(pagedOffsets.reader)})`,
    ).toBeLessThanOrEqual(2);
    expect(realApp.problems).toEqual([]);
    await testInfo.attach("scroll-trace.json", {
      body: JSON.stringify(trace, null, 1),
      contentType: "application/json",
    });
  },
);

realTest(
  "real omp: pressing a tool card above the reader's row leaves that row in place while the card opens and closes",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    const page = await realApp.open();
    await openLongChat(page);
    const viewport = page.locator(VIEWPORT);
    const trace: ReaderPlace[] = [];

    // The reader scrolls up to the top, away from the bottom, where the "Show earlier messages" control is on screen.
    const earlier = page.getByRole("button", { name: /Show earlier messages/ });
    for (let step = 0; step < 60; step += 1) {
      const transcript = await viewport.boundingBox();
      const control = (await earlier.count()) > 0 ? await earlier.first().boundingBox() : null;
      if (
        transcript !== null &&
        control !== null &&
        control.y >= transcript.y &&
        control.y + control.height <= transcript.y + transcript.height
      ) {
        break;
      }
      await viewport.hover({ position: GUTTER });
      await page.mouse.wheel(0, -1_500);
      await page.waitForTimeout(150);
    }
    await settle(page);

    // The reader's row is the message in the middle of the view. A tool card above that row in the chat is toggled from
    // the keyboard: its header takes focus without scrolling, so the view does not move before the card changes size.
    // The view scrolls a little at a time until such a card is above the reader's row.
    const cards = page.getByRole("button", { name: /^bash: / });
    let card = -1;
    let readerId: string | null = null;
    let readerBefore: ReaderPlace | null = null;
    for (let step = 0; step < 40 && card < 0; step += 1) {
      readerId = await readerRowAt(page, 0.5);
      readerBefore =
        readerId === null ? null : await placeOf(page, "before the card opens", readerId);
      const rowId = readerId ?? "";
      const count = await cards.count();
      for (let index = 0; index < count && card < 0; index += 1) {
        const above = await cards.nth(index).evaluate((element, id) => {
          const row = element.closest("[data-message-id]");
          const reader = Array.from(document.querySelectorAll("[data-message-id]")).find(
            (candidate) => candidate.getAttribute("data-message-id") === id,
          );
          return (
            row !== null &&
            reader !== undefined &&
            row !== reader &&
            (row.compareDocumentPosition(reader) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
          );
        }, rowId);
        if (above) card = index;
      }
      if (card < 0) {
        await viewport.hover({ position: GUTTER });
        await page.mouse.wheel(0, 500);
        await settle(page);
      }
    }
    expect(card, "a tool card sits above the reader's row in the chat").toBeGreaterThanOrEqual(0);
    if (readerId === null || readerBefore === null)
      throw new Error("the reader's row is not on screen");
    trace.push(readerBefore);
    // The header takes focus without scrolling; Enter opens the card. The rows below it change size, so the view keeps
    // the reader's row where it was.
    await cards.nth(card).evaluate((element) => {
      if (element instanceof HTMLElement) element.focus({ preventScroll: true });
    });
    await markRow(page, readerId, "reader");
    const opening = page.evaluate(sampleMarkedOffsetsInPage, { viewport: VIEWPORT, maxMs: 60_000 });
    await page.keyboard.press("Enter");
    await settle(page);
    await waitForFiniteAnimations(page);
    await stopSampling(page);
    const openSamples = await opening;
    expect(
      offRunOf(openSamples.reader ?? []),
      `the reader's row was painted in other places while the card opened (offsets: ${JSON.stringify(openSamples.reader)})`,
    ).toBeLessThanOrEqual(2);
    const readerOpen = await placeOf(page, "after the card opens", readerId);
    trace.push(readerOpen);
    expectStill(trace, readerBefore, readerOpen);
    const closing = page.evaluate(sampleMarkedOffsetsInPage, { viewport: VIEWPORT, maxMs: 60_000 });
    await page.keyboard.press("Enter");
    await settle(page);
    await waitForFiniteAnimations(page);
    await stopSampling(page);
    const closeSamples = await closing;
    expect(
      offRunOf(closeSamples.reader ?? []),
      `the reader's row was painted in other places while the card closed (offsets: ${JSON.stringify(closeSamples.reader)})`,
    ).toBeLessThanOrEqual(2);
    const readerClosed = await placeOf(page, "after the card closes", readerId);
    trace.push(readerClosed);
    expectStill(trace, readerOpen, readerClosed);
    expect(realApp.problems).toEqual([]);
    await testInfo.attach("scroll-trace.json", {
      body: JSON.stringify(trace, null, 1),
      contentType: "application/json",
    });
  },
);

realTest(
  "real omp: a mouse press on a tool card header above the reader's row keeps that header under the pointer while the card opens and closes",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    const page = await realApp.open();
    await openLongChat(page);
    // A bash card whose header is drawn above the reader's row. The reader presses the header, so the header is what must stay
    // under the pointer; the rows below it move as the card opens and closes.
    const { index, readerId } = await headerAroundReader(page, "above");
    const { header, opened } = await pressCardOpen(page, index, readerId);
    expect(
      offRunOf(opened.header ?? []),
      `the pressed header was drawn in other places while the card opened (offsets: ${JSON.stringify(opened.header)})`,
    ).toBeLessThanOrEqual(2);
    // The card sits above the reader's row: opening it moves that row down, in one direction, by the card's height.
    const reader = opened.reader ?? [];
    expect(
      movesOneWay(reader),
      `the reader's row moved back and forth while the card opened (offsets: ${JSON.stringify(reader)})`,
    ).toBe(true);
    expect(
      (reader[reader.length - 1] ?? 0) - (reader[0] ?? 0),
      `opening the card above the reader's row did not move that row (offsets: ${JSON.stringify(reader)})`,
    ).toBeGreaterThan(TOLERANCE_PX);
    const closed = await pressCardClose(page, header);
    expect(
      offRunOf(closed.header ?? []),
      `the pressed header was drawn in other places while the card closed (offsets: ${JSON.stringify(closed.header)})`,
    ).toBeLessThanOrEqual(2);
    expect(
      movesOneWay(closed.reader ?? []),
      `the reader's row moved back and forth while the card closed (offsets: ${JSON.stringify(closed.reader)})`,
    ).toBe(true);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: a mouse press on a tool card header below the reader's row leaves that header and the reader's row in place",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    const page = await realApp.open();
    await openLongChat(page);
    const { index, readerId } = await headerAroundReader(page, "below");
    const { header, opened } = await pressCardOpen(page, index, readerId);
    expect(
      offRunOf(opened.header ?? []),
      `the header below the reader's row was drawn in other places while the card opened (offsets: ${JSON.stringify(opened.header)})`,
    ).toBeLessThanOrEqual(2);
    expect(
      offRunOf(opened.reader ?? []),
      `the reader's row moved while a card below it opened (offsets: ${JSON.stringify(opened.reader)})`,
    ).toBeLessThanOrEqual(2);
    const closed = await pressCardClose(page, header);
    expect(
      offRunOf(closed.header ?? []),
      `the header below the reader's row was drawn in other places while the card closed (offsets: ${JSON.stringify(closed.header)})`,
    ).toBeLessThanOrEqual(2);
    expect(
      offRunOf(closed.reader ?? []),
      `the reader's row moved while a card below it closed (offsets: ${JSON.stringify(closed.reader)})`,
    ).toBeLessThanOrEqual(2);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: the wheel moves the reader's row by its step, and a streamed reply, the turn's end and a reload leave it in place",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    const page = await realApp.open();
    await openLongChat(page);
    const viewport = page.locator(VIEWPORT);
    const trace: ReaderPlace[] = [];

    // The reader scrolls up and down one step at a time: the row in the middle moves by exactly the step.
    for (const direction of [-1, -1, -1, -1, -1, -1, 1, 1, 1, 1, 1, 1]) {
      const rowId = await readerRowAt(page, 0.5);
      expect(rowId, "a message row is in the middle of the transcript").not.toBeNull();
      const before = await placeOf(page, `before wheel ${direction * 500}`, rowId ?? "");
      await viewport.hover({ position: GUTTER });
      await page.mouse.wheel(0, direction * 500);
      await settle(page);
      const after = await placeOf(page, `after wheel ${direction * 500}`, rowId ?? "");
      trace.push(before, after);
      const moved = before.top === null || after.top === null ? Number.NaN : after.top - before.top;
      expect(
        Math.abs(moved + direction * 500),
        `the wheel step of ${direction * 500}px moved the reader's row ${moved}px (trace: ${JSON.stringify(trace)})`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }

    // A reply streams while the reader is away from the bottom.
    const composer = page.getByRole("textbox", { name: "Message input" });
    await sendPrompt(composer, "stream_long_code");
    await expect(page.getByText("Here is the long streamed block:")).toBeVisible({
      timeout: 90_000,
    });
    await viewport.hover({ position: GUTTER });
    await page.mouse.wheel(0, -1_500);
    await page.waitForTimeout(400);
    const streamRow = await readerRowAt(page, 0.5);
    expect(streamRow, "a message row is in the middle of the transcript").not.toBeNull();
    const streamBefore = await placeOf(page, "while the reply streams", streamRow ?? "");
    trace.push(streamBefore);
    // The reader's row, marked for the layout sampler: while the reply streams and the turn ends, no frame may paint it in
    // another place (a change above the reader is painted before a correction that runs a frame later can undo it).
    await markRow(page, streamRow ?? "", "reader");
    const streaming = page.evaluate(sampleMarkedOffsetsInPage, {
      viewport: VIEWPORT,
      maxMs: 180_000,
    });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 180_000 });
    await settle(page);
    await stopSampling(page);
    const turnOffsets = await streaming;
    const streamAfter = await placeOf(page, "after the turn ends", streamRow ?? "");
    trace.push(streamAfter);
    expectStill(trace, streamBefore, streamAfter);
    expect(
      offRunOf(turnOffsets.reader ?? []),
      `the reader's row was painted in other places while the reply streamed (offsets: ${JSON.stringify(turnOffsets.reader)})`,
    ).toBeLessThanOrEqual(2);

    // A browser reload brings the reader back to the same row, at the same place on screen.
    const reloadRow = await readerRowAt(page, 0.5);
    expect(reloadRow, "a message row is in the middle of the transcript").not.toBeNull();
    const reloadBefore = await placeOf(page, "before the reload", reloadRow ?? "");
    trace.push(reloadBefore);
    await page.reload();
    await expect(viewport).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(async () => (await placeOf(page, "waiting", reloadRow ?? "")).top, { timeout: 90_000 })
      .not.toBeNull();
    await settle(page);
    const reloadAfter = await placeOf(page, "after the reload", reloadRow ?? "");
    trace.push(reloadAfter);
    expectStill(trace, reloadBefore, reloadAfter);
    expect(realApp.problems).toEqual([]);
    await testInfo.attach("scroll-trace.json", {
      body: JSON.stringify(trace, null, 1),
      contentType: "application/json",
    });
  },
);

/*
 * Issue 1165, review of PR 1193. The newest message is short and sits at the top of the view with empty space under it.
 * The earlier message is larger than the newest window, so it is paged in on request. Paging in removes that space: the
 * transcript is then taller than the view, and the browser cannot scroll the newest message to the top. The message moves by
 * exactly that space and no more.
 */
const MIDDLE_CHARACTERS = 4_500_000;

function shortNewestLines(folder: string): string[] {
  const header = {
    type: "session",
    version: 3,
    id: "short-newest-paging-e2e",
    timestamp: "2026-10-05T00:00:00.000Z",
    cwd: folder,
  };
  const body = "lorem ipsum ".repeat(Math.ceil(MIDDLE_CHARACTERS / 12));
  const entries = [
    {
      type: "message",
      id: "short-1",
      parentId: null,
      timestamp: "2026-10-05T00:00:01.000Z",
      message: { role: "user", content: `MIDDLE-MARK ${body}`, timestamp: 1 },
    },
    {
      type: "message",
      id: "short-2",
      parentId: "short-1",
      timestamp: "2026-10-05T00:00:02.000Z",
      message: { role: "user", content: "NEWEST-MARK is short.", timestamp: 2 },
    },
  ];
  return [header, ...entries].map((line) => JSON.stringify(line));
}

realTest.describe("a short newest message above an earlier one outside the newest window", () => {
  realTest.use({ seedEntries: undefined });

  realTest(
    "paging in the earlier message moves the short newest message by exactly the empty space under it",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(300_000);
      const root = dirname(realApp.folder);
      const home = join(root, "home");
      const bucket = join(root, "agent", "sessions", sessionBucketName(realApp.folder, { home }));
      await mkdir(bucket, { recursive: true });
      await writeFile(
        join(bucket, "2026-10-05T00-00-00-000Z_short-newest-paging-e2e.jsonl"),
        `${shortNewestLines(realApp.folder).join("\n")}\n`,
      );
      const page = await realApp.open();
      const list = page.getByRole("listbox", { name: "Session list" });
      await expect(list.getByRole("option").first()).toBeVisible({ timeout: 60_000 });
      await list.getByRole("option").first().click();
      const earlier = page.getByRole("button", { name: "Show earlier messages" });
      await expect(earlier).toBeVisible({ timeout: 60_000 });
      const viewport = page.locator(VIEWPORT);
      await expect(viewport.getByText("NEWEST-MARK")).toBeVisible();
      await expect(viewport.getByText("MIDDLE-MARK")).toHaveCount(0);
      await viewport.evaluate((element) => {
        element.scrollTop = 0;
      });
      await settle(page);
      // The newest message's offset from the top edge of the view, and the empty space under it, before the click.
      const before = await page.evaluate(newestPlaceInPage, VIEWPORT);
      if (before === null) throw new Error("the newest message is not on screen before paging");
      expect(
        before.empty,
        "there is empty space under the newest message before paging",
      ).toBeGreaterThan(50);
      // Every frame from here until the older message has settled in: the offset may move once, by that space.
      const watch = page.evaluate(followOffsetInPage, {
        selector: VIEWPORT,
        settleMs: 2_000,
        maxMs: 60_000,
      });
      // A script click: a Playwright click would scroll the control into view and move the reader.
      await earlier.evaluate((button) => {
        if (button instanceof HTMLElement) {
          button.focus({ preventScroll: true });
          button.click();
        }
      });
      const watched = await watch;
      await expect(viewport.getByText("MIDDLE-MARK")).toBeVisible({ timeout: 60_000 });
      await expect(earlier).toBeHidden();
      const moved = watched.final - before.offset;
      expect(
        Math.abs(moved - before.empty),
        `the newest message moved ${Math.round(moved)}px; the empty space under it before paging was ${Math.round(before.empty)}px`,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
      expect(watched.min, "the newest message never moved up").toBeGreaterThanOrEqual(
        before.offset - TOLERANCE_PX,
      );
      expect(
        watched.max,
        "the newest message never moved past where it settled",
      ).toBeLessThanOrEqual(watched.final + TOLERANCE_PX);
      expect(watched.pagedAt, "the older message came in").not.toBeNaN();
      expect(
        watched.settledAt - watched.pagedAt,
        "the newest message was still moving in the two seconds after the older message came in",
      ).toBeLessThan(1_000);
      expect(realApp.problems).toEqual([]);
    },
  );
});

/** Runs in the page: the newest message's offset from the top edge of the transcript, and the empty space under it. */
function newestPlaceInPage(selector: string): { offset: number; empty: number } | null {
  const viewport = document.querySelector<HTMLElement>(selector);
  if (viewport === null) return null;
  const list = viewport.querySelector<HTMLElement>('[data-slot="u1-thread-messages"]');
  const rows = document.querySelectorAll<HTMLElement>("[data-message-id]");
  const row = rows.item(rows.length - 1);
  if (list === null || row === null) return null;
  const rowBox = row.getBoundingClientRect();
  return {
    offset: rowBox.top - viewport.getBoundingClientRect().top,
    empty: list.getBoundingClientRect().bottom - rowBox.bottom,
  };
}

/**
 * Runs in the page, one frame at a time: the newest message's offset from the top edge of the transcript, from the start
 * until two seconds after the older message is on screen (at most `maxMs`). It reports the lowest and the highest offset, the
 * final one, when the older message came in, and when the offset last changed (to a whole pixel). Self-contained: Playwright
 * ships only this function's source to the page.
 */
function followOffsetInPage(options: {
  selector: string;
  settleMs: number;
  maxMs: number;
}): Promise<{
  min: number;
  max: number;
  final: number;
  pagedAt: number;
  settledAt: number;
}> {
  return new Promise((resolve) => {
    const started = performance.now();
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let final = Number.NaN;
    let pagedAt: number | undefined;
    let settledAt = 0;
    let previous: number | undefined;
    const frame = (): void => {
      const now = performance.now() - started;
      const viewport = document.querySelector<HTMLElement>(options.selector);
      const rows = document.querySelectorAll<HTMLElement>("[data-message-id]");
      const row = rows.item(rows.length - 1);
      const offset =
        viewport === null || row === null
          ? Number.NaN
          : row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      const whole = Math.round(offset);
      if (whole !== previous) {
        previous = whole;
        settledAt = now;
      }
      min = Math.min(min, offset);
      max = Math.max(max, offset);
      final = offset;
      const pagedIn =
        rows.length >= 2 && document.querySelector('[data-slot="u1-earlier-messages"]') === null;
      if (pagedIn && pagedAt === undefined) pagedAt = now;
      const done = pagedAt === undefined ? now >= options.maxMs : now - pagedAt >= options.settleMs;
      if (done) resolve({ min, max, final, pagedAt: pagedAt ?? Number.NaN, settledAt });
      else requestAnimationFrame(frame);
    };
    frame();
  });
}
