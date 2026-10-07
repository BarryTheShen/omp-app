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

/**
 * Feedback #654: on a wide window the conversation was a 48rem column with about 1000 px of empty
 * space around it. The width is one layout token (`--layout-thread-width`, 60rem); the composer and
 * the queue bar line up with the transcript.
 */
const THREAD_WIDTH_REM = 60;

async function setSidebars(page: Page, open: boolean): Promise<void> {
  for (const side of ["sessions", "panels"] as const) {
    const hide = page.getByRole("button", { name: `Hide ${side} sidebar` });
    const show = page.getByRole("button", { name: `Show ${side} sidebar` });
    if (open && (await show.count()) > 0) await show.first().click();
    if (!open && (await hide.count()) > 0) await hide.first().click();
  }
}

interface Columns {
  readonly transcript: { readonly left: number; readonly right: number };
  readonly composer: { readonly left: number; readonly right: number };
  readonly composerBox: { readonly left: number; readonly right: number };
  readonly toolCard: { readonly left: number; readonly right: number };
  readonly area: { readonly left: number; readonly right: number };
}

async function measureColumns(page: Page): Promise<Columns> {
  return page.evaluate(() => {
    const edges = (element: Element | null) => {
      if (!element) throw new Error("an element to measure is missing");
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };
    // The message row and the composer's wrapper both carry the column width and 1.5rem of padding.
    const message = document.querySelector('[data-slot="u1-message-row"][data-role="assistant"]');
    const card = document.querySelector('[data-testid^="tool-card-"]');
    const wrapper = document.querySelector('[data-shell-region="composer"] > div');
    const form = document.querySelector('[data-shell-region="composer"] form');
    const main = document.querySelector('main[aria-label="Conversation"]');
    return {
      transcript: edges(message),
      composer: edges(wrapper),
      composerBox: edges(form),
      toolCard: edges(card),
      area: edges(main),
    };
  });
}

realTest(
  "the conversation uses a moderate share of a wide window and the composer lines up with it",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1771, height: 1100 });
    const composer = await startChat(page);
    await sendPrompt(composer, "Please run_bash and tell me what it printed.");
    await expect(page.getByText("tool said: fixture-tool")).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('[data-testid^="tool-card-"]').first()).toBeVisible();
    await mkdir(screenshots, { recursive: true });

    for (const size of [
      { name: "laptop", width: 1280, height: 800 },
      { name: "user", width: 1771, height: 1100 },
      { name: "monitor", width: 1920, height: 1080 },
    ] as const) {
      for (const sidebars of [false, true] as const) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await setSidebars(page, sidebars);
        await waitForFiniteAnimations(page);
        const columns = await measureColumns(page);
        const label = `${size.name}, sidebars ${sidebars ? "open" : "closed"}`;
        const columnWidth = columns.transcript.right - columns.transcript.left;
        const areaWidth = columns.area.right - columns.area.left;
        const expected = Math.min(areaWidth, THREAD_WIDTH_REM * 16);
        expect(columnWidth, `${label}: column width`).toBeGreaterThanOrEqual(expected - 2);
        expect(columnWidth, `${label}: column width`).toBeLessThanOrEqual(expected + 2);
        // The composer and the transcript share the same left and right edges.
        expect(
          Math.abs(columns.composer.left - columns.transcript.left),
          `${label}: composer left`,
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(columns.composer.right - columns.transcript.right),
          `${label}: composer right`,
        ).toBeLessThanOrEqual(2);
        // The composer's visible box starts where the messages' text starts (1.5rem of padding).
        expect(
          Math.abs(columns.composerBox.left - (columns.transcript.left + 24)),
          `${label}: composer box left`,
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(columns.composerBox.right - (columns.transcript.right - 24)),
          `${label}: composer box right`,
        ).toBeLessThanOrEqual(2);
        // Tool cards use the column and never stick out of it.
        expect(columns.toolCard.left, `${label}: card left`).toBeGreaterThanOrEqual(
          columns.transcript.left - 1,
        );
        expect(columns.toolCard.right, `${label}: card right`).toBeLessThanOrEqual(
          columns.transcript.right + 1,
        );
        await page.screenshot({
          path: join(
            screenshots,
            `chat-width-${size.name}-sidebars-${sidebars ? "open" : "closed"}.png`,
          ),
        });
      }
    }
  },
);
