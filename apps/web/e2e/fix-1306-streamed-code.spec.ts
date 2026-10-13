import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(420_000);

/** The prompt the fake model answers with a long streamed code block (about twenty seconds). */
const PROMPT = "stream_long_code please";
/** Sent once the first rows have streamed: a steer during the reply, the trigger of the repeated rows. */
const STEER = "steer one";
/** The rows of the code block that name a value: each is unique in the block, so a second copy is a repeat. */
const ROW_PREFIX = "export const value";

interface CodeRowWatch {
  stop: boolean;
  frames: number;
  maxRepeats: number;
  sample: string[] | null;
}

declare global {
  interface Window {
    __codeRows?: CodeRowWatch;
  }
}

/**
 * Runs in the page before the reply: on each animation frame, counts how many value rows of the code block repeat a row
 * above them, and keeps the rows of the frame with the most repeats.
 */
function watchCodeRows(prefix: string): void {
  const watch: CodeRowWatch = { stop: false, frames: 0, maxRepeats: 0, sample: null };
  window.__codeRows = watch;
  const tick = (): void => {
    const rows = Array.from(
      document.querySelectorAll("[data-code-view] code > span.block"),
      (row) => row.textContent ?? "",
    ).filter((row) => row.startsWith(prefix));
    const seen = new Set<string>();
    let repeats = 0;
    for (const row of rows) {
      if (seen.has(row)) repeats += 1;
      else seen.add(row);
    }
    watch.frames += 1;
    if (repeats > watch.maxRepeats) {
      watch.maxRepeats = repeats;
      watch.sample = rows.slice(0, 8);
    }
    if (!watch.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Turns the theme on or off the way the Settings toggle does: the root's `dark` class, then the page settles. */
async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

/**
 * Issue 1306. A streamed code block showed some of its lines twice until the reply ended. While a long code block
 * streams and a steer lands mid-reply, no animation frame may show a value row twice.
 */
realTest(
  "a streamed code block shows each of its rows once while a steer lands mid-reply",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.evaluate(watchCodeRows, ROW_PREFIX);
    await sendPrompt(composer, PROMPT);
    const code = page.locator("[data-code-view]");
    await expect(code.getByText("export const value0:")).toBeVisible({ timeout: 60_000 });
    await sendPrompt(composer, STEER);
    // The reply has ended when its Stop control is gone.
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 180_000 });
    const watch = await page.evaluate(() => {
      const state = window.__codeRows;
      if (state === undefined) throw new Error("the code rows were not watched");
      state.stop = true;
      return { frames: state.frames, maxRepeats: state.maxRepeats, sample: state.sample };
    });
    expect(watch.frames, "the rows were watched while the reply streamed").toBeGreaterThan(10);
    expect(
      watch.maxRepeats,
      `no value row repeats while the reply streams; the worst frame showed ${JSON.stringify(watch.sample)}`,
    ).toBe(0);
    await expect(code.getByText("export const value0:")).toHaveCount(1);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1306-streamed-code-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1306-streamed-code-dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1306-streamed-code-390.png") });
  },
);
