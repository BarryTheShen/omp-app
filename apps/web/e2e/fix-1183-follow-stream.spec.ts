import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots } from "./real-omp";

/*
 * Issue 1183 (part of 1165): a reader who scrolls up a little while a reply streams is pulled back to the bottom. Here the
 * transcript grows on every animation frame, as a streamed reply does, while the reader makes wheel steps of two notches
 * every half second. Red on main: the view goes back to the bottom and "Jump to latest" never shows. Green with the fix:
 * the reader stays where they put it and "Jump to latest" shows; at the bottom the view still follows the growth; a reader
 * who scrolls back to the bottom resumes following.
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
 * A chat of 64 turns, each with one bash call whose output is 75 KB: 256 messages, long enough to scroll through and to
 * open at its newest message.
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
/** How far from the bottom a transcript that follows the stream can be: the lag of a frame or two. */
const FOLLOW_TOLERANCE_PX = 12;
/** How far from the bottom a reader counts as away: well past the growth of a few frames. */
const AWAY_PX = 150;

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

/** How far the transcript is from its bottom, in pixels. */
async function distanceFromBottom(page: Page): Promise<number> {
  return page
    .locator(VIEWPORT)
    .evaluate((element) =>
      Math.round(element.scrollHeight - element.clientHeight - element.scrollTop),
    );
}

/** Two notches of the wheel up (200 px), then half a second: the step the report describes. */
async function twoNotchesUp(page: Page): Promise<void> {
  await page.locator(VIEWPORT).hover({ position: GUTTER });
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, -100);
  // Two notches every half second, the cadence of the report. The transcript grows meanwhile.
  await page.waitForTimeout(500);
}

/**
 * Test only: the transcript grows by three pixels on every animation frame until it is stopped, as a streamed reply
 * grows it. Each frame's growth lands between two of the reader's scroll events, which is what undid the reader's steps.
 */
async function growTranscript(page: Page): Promise<void> {
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-slot="u1-thread-messages"]');
    if (list === null) throw new Error("no message list");
    const spacer = document.createElement("div");
    spacer.dataset.testGrowth = "transcript";
    spacer.dataset.growing = "true";
    list.append(spacer);
    let height = 0;
    const grow = (): void => {
      if (spacer.dataset.growing !== "true") return;
      height += 3;
      spacer.style.height = `${height}px`;
      window.requestAnimationFrame(grow);
    };
    window.requestAnimationFrame(grow);
  });
}

async function stopTranscriptGrowth(page: Page): Promise<void> {
  await page.evaluate(() => {
    const spacer = document.querySelector<HTMLElement>('[data-test-growth="transcript"]');
    if (spacer !== null) spacer.dataset.growing = "false";
  });
}

realTest(
  "real omp: a reader who scrolls up in small steps while the reply grows on every frame is kept where they are, and Jump to latest shows",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await openLongChat(page);
    const jump = page.getByRole("button", { name: "Jump to latest message" });
    await growTranscript(page);
    const distances: number[] = [];
    try {
      for (let step = 0; step < 8; step += 1) {
        await twoNotchesUp(page);
        distances.push(await distanceFromBottom(page));
      }
    } finally {
      await stopTranscriptGrowth(page);
    }
    expect(
      Math.min(...distances),
      `the transcript was pulled back to the bottom while the reader scrolled up (distances: ${distances.join(", ")})`,
    ).toBeGreaterThan(AWAY_PX);
    expect(
      distances[distances.length - 1] ?? 0,
      `distances: ${distances.join(", ")}`,
    ).toBeGreaterThan((distances[0] ?? 0) + 400);
    await expect(jump).toBeVisible();
    expect(realApp.problems).toEqual([]);
    await testInfo.attach("scroll-distances.json", {
      body: JSON.stringify(distances),
      contentType: "application/json",
    });
  },
);

realTest(
  "real omp: a reader who scrolls up in one large step while the reply grows on every frame is kept where they are, and Jump to latest shows",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await openLongChat(page);
    const jump = page.getByRole("button", { name: "Jump to latest message" });
    await growTranscript(page);
    try {
      await page.waitForTimeout(1_000);
      await page.locator(VIEWPORT).hover({ position: GUTTER });
      // One large step: six notches in a single wheel event, the larger step the report describes.
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(2_000);
      expect(
        await distanceFromBottom(page),
        "after one large step the reader is away from the bottom",
      ).toBeGreaterThan(AWAY_PX);
      await expect(jump).toBeVisible();
    } finally {
      await stopTranscriptGrowth(page);
    }
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: at the bottom the view follows a reply that grows on every frame, and a reader who scrolls back to the bottom resumes following",
  async ({ realApp }) => {
    const page = await realApp.open();
    await openLongChat(page);
    const jump = page.getByRole("button", { name: "Jump to latest message" });
    await growTranscript(page);
    try {
      await page.waitForTimeout(2_000);
      expect(
        await distanceFromBottom(page),
        "at the bottom, the view follows the growing reply",
      ).toBeLessThanOrEqual(FOLLOW_TOLERANCE_PX);
      for (let step = 0; step < 4; step += 1) await twoNotchesUp(page);
      expect(await distanceFromBottom(page), "the reader is away from the bottom").toBeGreaterThan(
        AWAY_PX,
      );
      await expect(jump).toBeVisible();

      // The reader scrolls back down; once at the bottom, the view follows again.
      for (
        let step = 0;
        step < 40 && (await distanceFromBottom(page)) > FOLLOW_TOLERANCE_PX;
        step += 1
      ) {
        await page.locator(VIEWPORT).hover({ position: GUTTER });
        await page.mouse.wheel(0, 500);
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(2_000);
      expect(
        await distanceFromBottom(page),
        "after the reader returns to the bottom, the view follows the reply again",
      ).toBeLessThanOrEqual(FOLLOW_TOLERANCE_PX);
      await expect(jump).toBeHidden();
    } finally {
      await stopTranscriptGrowth(page);
    }
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "real omp: captures of a reader away from the bottom with Jump to latest, at 1280, 1920 and 390 px, and in dark at 1280 px",
  async ({ realApp }) => {
    const page = await realApp.open();
    await openLongChat(page);
    const jump = page.getByRole("button", { name: "Jump to latest message" });
    await mkdir(screenshots, { recursive: true });
    for (const size of [
      { name: "1280", width: 1280, height: 900 },
      { name: "1920", width: 1920, height: 1080 },
      { name: "390", width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await settle(page);
      for (let step = 0; step < 3; step += 1) await twoNotchesUp(page);
      await expect(jump).toBeVisible();
      await page.screenshot({ path: join(screenshots, `fix-1183-away-${size.name}.png`) });
      await page.locator(VIEWPORT).hover({ position: GUTTER });
      await page.mouse.wheel(0, 50_000);
      await settle(page);
      await expect(jump).toBeHidden();
      await page.screenshot({ path: join(screenshots, `fix-1183-bottom-${size.name}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await settle(page);
    for (let step = 0; step < 3; step += 1) await twoNotchesUp(page);
    await expect(jump).toBeVisible();
    await page.screenshot({ path: join(screenshots, "fix-1183-away-dark-1280.png") });
    expect(realApp.problems).toEqual([]);
  },
);
