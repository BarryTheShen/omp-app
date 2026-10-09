import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** The fenced block the fake model streams for `stream_code`, one row per line. */
const BLOCK_ROWS = [
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (const value of values) {",
  "    total += value;",
  "  }",
  "  return total;",
  "}",
  "",
  "export const answer = sum([1, 2, 3]);",
];
const FINAL_ROW = "export const answer = sum([1, 2, 3]);";

/**
 * The block the fake model streams for `stream_long_code` (packages/omp-rpc/scripts/fake-openai-server.ts): over
 * the code view's 2,048-character short-block limit, so the block is coloured in the background as it grows.
 */
const LONG_BLOCK_ROWS = Array.from(
  { length: 48 },
  (_, index) => `export const value${index}: number = ${index} * 2; // step ${index}`,
);
const LONG_FINAL_ROW = LONG_BLOCK_ROWS.at(-1) ?? "";

interface BlockRow {
  readonly text: string;
  readonly coloured: boolean;
}

/** The streamed block as one animation frame shows it. */
interface BlockFrame {
  /** How many code views the page holds. */
  readonly views: number;
  /** The block's `data-code-state`: `highlighted` once any of its rows is coloured. */
  readonly state: string | null;
  readonly rows: readonly BlockRow[];
}

/**
 * Runs in the page. Records the first code view on every animation frame until its final row is coloured
 * and ten frames have passed (or after a long cap, so a stalled reply fails the assertions, not the timeout).
 */
function recordBlockFrames(finalRow: string): Promise<BlockFrame[]> {
  return new Promise<BlockFrame[]>((resolve) => {
    const frames: BlockFrame[] = [];
    let ticks = 0;
    let framesAfterFinal = 0;
    const tick = (): void => {
      ticks += 1;
      const view = document.querySelector("[data-code-view]");
      if (view !== null) {
        const rows = Array.from(view.querySelectorAll("code > span.block"), (row) => ({
          text: row.textContent ?? "",
          coloured: row.querySelector("[data-code-token]") !== null,
        }));
        frames.push({
          views: document.querySelectorAll("[data-code-view]").length,
          state: view.querySelector("pre")?.getAttribute("data-code-state") ?? null,
          rows,
        });
        if (rows.some((row) => row.coloured && row.text === finalRow)) framesAfterFinal += 1;
      }
      if (framesAfterFinal >= 10 || ticks >= 9000) {
        resolve(frames);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * What the frames of one streamed block must show: one code view on every frame, the block passing through
 * several texts, no plain frame once it has colours (including the frame a transcript row remounts it), completed
 * lines keeping their colours, and a last frame that is the whole block with every line coloured.
 */
function expectBlockStreamedWithColours(
  frames: readonly BlockFrame[],
  rows: readonly string[],
): void {
  expect(frames.length).toBeGreaterThan(10);
  expect(new Set(frames.map((frame) => frame.views))).toEqual(new Set([1]));

  // The reply arrived in pieces: the block passed through several different texts.
  const texts = new Set(
    frames.map((frame) => frame.rows.map((row) => row.text.trimEnd()).join("\n")),
  );
  expect(texts.size).toBeGreaterThan(4);

  // The block never turns plain once it has colours, including on the frame a transcript row remounts it.
  const firstColoured = frames.findIndex((frame) => frame.state === "highlighted");
  expect(firstColoured).toBeGreaterThanOrEqual(0);
  const plainAfterColour = frames
    .slice(firstColoured)
    .flatMap((frame, index) =>
      frame.state === "highlighted" ? [] : [`${index + firstColoured}: ${frame.rows.length} rows`],
    );
  expect(plainAfterColour).toEqual([]);

  // A line that is complete (not the last row) and coloured keeps its colours while its text is unchanged.
  const lost: string[] = [];
  const completedColoured = new Map<number, string>();
  for (const frame of frames) {
    frame.rows.forEach((row, index) => {
      const remembered = completedColoured.get(index);
      if (remembered !== undefined && remembered === row.text && !row.coloured) {
        lost.push(`row ${index}: ${row.text}`);
      }
      if (remembered === undefined && row.coloured && index < frame.rows.length - 1) {
        completedColoured.set(index, row.text);
      }
    });
  }
  expect(lost).toEqual([]);
  expect(completedColoured.size).toBeGreaterThanOrEqual(4);

  // The final frame is the whole block, and every line with text is coloured.
  const last = frames.at(-1);
  expect(last?.rows.map((row) => row.text.trimEnd())).toEqual(rows);
  expect(last?.rows.filter((row) => row.text.trim() !== "" && !row.coloured).length).toBe(0);
}

realTest(
  "a code block that streams in keeps its colours on every frame while it grows",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    // Sampling starts before the prompt is sent, so the block's first frame is caught too.
    const sampling = page.evaluate(recordBlockFrames, FINAL_ROW);
    void sampling.catch(() => undefined);
    await sendPrompt(composer, "stream_code: show the streamed block");
    await expect(page.locator("p", { hasText: "Here is the streamed block:" })).toBeVisible({
      timeout: 60_000,
    });
    const frames = await sampling;

    expectBlockStreamedWithColours(frames, BLOCK_ROWS);

    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page
      .locator("[data-code-view]")
      .first()
      .screenshot({ path: join(screenshots, "code-view-stream-final.png") });
  },
);

realTest(
  "a block longer than the short-block limit keeps its colours as it grows, on a four-times slower CPU",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    // Lighthouse's mid-tier mobile CPU: the background highlight must still land on the final text.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const composer = await startChat(page);
    const sampling = page.evaluate(recordBlockFrames, LONG_FINAL_ROW);
    void sampling.catch(() => undefined);
    await sendPrompt(composer, "stream_long_code: show the long streamed block");
    await expect(page.locator("p", { hasText: "Here is the long streamed block:" })).toBeVisible({
      timeout: 120_000,
    });
    const frames = await sampling;

    // The block really passed the limit: its last text is longer than 2,048 characters.
    const lastText =
      frames
        .at(-1)
        ?.rows.map((row) => row.text)
        .join("\n") ?? "";
    expect(lastText.length).toBeGreaterThan(2_048);
    expectBlockStreamedWithColours(frames, LONG_BLOCK_ROWS);
  },
);
