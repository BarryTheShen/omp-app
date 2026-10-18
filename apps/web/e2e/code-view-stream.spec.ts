import { mkdir, writeFile } from "node:fs/promises";
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

/** What the page recorded for one streamed block: every animation frame, and each text the block showed. */
interface RecordedBlock {
  readonly frames: BlockFrame[];
  /** Each distinct text the first code view showed, as each change to the page left it. */
  readonly texts: readonly string[];
}

/**
 * Runs in the page. Records the first code view on every animation frame until its final row is coloured
 * and ten frames have passed (or after a long cap, so a stalled reply fails the assertions, not the timeout).
 * How many texts the frames show depends on how many frames a busy machine paints during the stream, so the
 * texts are also taken from every change to the page: each piece of the reply that the page renders.
 */
function recordBlockFrames(finalRow: string): Promise<RecordedBlock> {
  return new Promise<RecordedBlock>((resolve) => {
    const frames: BlockFrame[] = [];
    const texts = new Set<string>();
    let ticks = 0;
    let framesAfterFinal = 0;
    const observer = new MutationObserver(() => {
      const view = document.querySelector("[data-code-view]");
      if (view === null) return;
      texts.add(
        Array.from(view.querySelectorAll("code > span.block"), (row) =>
          (row.textContent ?? "").trimEnd(),
        ).join("\n"),
      );
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
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
        observer.disconnect();
        resolve({ frames, texts: [...texts] });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * The sampled-frame checks below prove retained colours and the final block. The held-reply test proves non-empty
 * growth deterministically before release; these ordinary streamed tests keep their relaxed frame assertions because
 * browser scheduling can skip intermediate DOM snapshots.
 */
function expectBlockStreamedWithColours(
  { frames, texts }: RecordedBlock,
  rows: readonly string[],
): void {
  expect(new Set(frames.map((frame) => frame.views))).toEqual(new Set([1]));
  const finalText = rows.join("\n");
  expect(
    frames.some((frame) => frame.rows.map((row) => row.text.trimEnd()).join("\n") !== finalText),
  ).toBe(true);

  // The reply arrived in pieces: the block passed through several different texts, as the page changed.
  expect(texts.length).toBeGreaterThan(4);

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
    const recorded = await sampling;

    expectBlockStreamedWithColours(recorded, BLOCK_ROWS);

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
    const recorded = await sampling;

    // The block really passed the limit: its last text is longer than 2,048 characters.
    const lastText =
      recorded.frames
        .at(-1)
        ?.rows.map((row) => row.text)
        .join("\n") ?? "";
    expect(lastText.length).toBeGreaterThan(2_048);
    expectBlockStreamedWithColours(recorded, LONG_BLOCK_ROWS);
  },
);
realTest(
  "a held code stream has a coloured non-empty prefix before it is released",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "stream_held: show the held streamed block");

    await expect
      .poll(
        () =>
          page
            .locator("[data-code-view]")
            .first()
            .evaluate((view, expected) => {
              const text = Array.from(view.querySelectorAll("code > span.block"), (row) =>
                (row.textContent ?? "").trimEnd(),
              ).join("\n");
              return (
                text.length > 0 &&
                text !== expected &&
                expected.startsWith(text) &&
                view.querySelector("[data-code-token]") !== null
              );
            }, LONG_BLOCK_ROWS.join("\n")),
        { timeout: 120_000 },
      )
      .toBe(true);

    const sampling = page.evaluate(recordBlockFrames, LONG_FINAL_ROW);
    void sampling.catch(() => undefined);
    await writeFile(join(realApp.agentDir, "release-held-reply"), "");
    await expect(page.locator("p", { hasText: "Here is the long streamed block:" })).toBeVisible({
      timeout: 120_000,
    });
    const frames = await sampling;
    expectBlockStreamedWithColours(frames, LONG_BLOCK_ROWS);
    expect(realApp.problems).toEqual([]);
  },
);
