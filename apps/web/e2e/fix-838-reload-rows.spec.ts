import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator } from "@playwright/test";
import { sessionBucketName } from "../../../packages/server/src/modules/A1/sessions/paths";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * Issue #838, review of PR #891. The giant-row spec cannot see a place lost between rows: a real chat has many
 * messages of different heights, and their heights settle after the first placement. This chat has forty
 * messages, read from its own session file in a short window. A reload must put the same message at the same
 * offset (within 8 px), and the reader must not be left at the bottom.
 */
const LINES = [1, 40, 3, 220, 8, 90, 2, 500, 15, 60];
const VIEWPORT = '[data-slot="u1-thread-viewport"]';

function sessionLines(folder: string): string[] {
  const header = {
    type: "session",
    version: 3,
    id: "fix-838-rows-e2e",
    timestamp: "2026-10-05T00:00:00.000Z",
    cwd: folder,
  };
  const entries = Array.from({ length: 40 }, (_, index) => ({
    type: "message",
    id: `rows-${index + 1}`,
    parentId: index === 0 ? null : `rows-${index}`,
    timestamp: `2026-10-05T00:00:${String(index).padStart(2, "0")}.000Z`,
    message: {
      role: "user",
      content: `ROW-${index} ${"lorem ipsum dolor sit amet ".repeat(LINES[index % LINES.length] ?? 1)}`,
      timestamp: index + 1,
    },
  }));
  return [header, ...entries].map((line) => JSON.stringify(line));
}

/** The message under the point 5% down the viewport, and how far its top sits below the viewport's top. */
async function anchorOf(viewport: Locator): Promise<{ id: string; offset: number } | null> {
  return viewport.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height * 0.05);
    const row = hit?.closest("[data-message-id]");
    if (!(row instanceof HTMLElement) || !element.contains(row)) return null;
    return { id: row.dataset.messageId ?? "", offset: row.getBoundingClientRect().top - box.top };
  });
}

async function offsetOf(viewport: Locator, id: string): Promise<number | null> {
  return viewport.evaluate((element, messageId) => {
    const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (candidate) => candidate.dataset.messageId === messageId,
    );
    return row === undefined
      ? null
      : row.getBoundingClientRect().top - element.getBoundingClientRect().top;
  }, id);
}

async function distanceFromBottom(viewport: Locator): Promise<number> {
  return viewport.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

/** Two frames: the scroll event that saves the place has fired by then. */
async function twoFrames(viewport: Locator): Promise<void> {
  await viewport.evaluate(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    await promise;
  });
}

realTest(
  "a reload returns a long multi-message chat to the same message at the same offset",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const root = dirname(realApp.folder);
    const home = join(root, "home");
    const bucket = join(root, "agent", "sessions", sessionBucketName(realApp.folder, { home }));
    await mkdir(bucket, { recursive: true });
    await writeFile(
      join(bucket, "2026-10-05T00-00-00-000Z_fix-838-rows-e2e.jsonl"),
      `${sessionLines(realApp.folder).join("\n")}\n`,
    );

    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 600 });
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 60_000 });
    await list.getByRole("option").first().click();
    const viewport = page.locator(VIEWPORT);
    await expect(viewport.getByText("ROW-39 lorem")).toBeVisible({ timeout: 60_000 });

    // Read from the middle of the chat, where rows of every height sit around the reader.
    await viewport.evaluate((element) => {
      element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) * 0.45);
    });
    await twoFrames(viewport);
    const before = await anchorOf(viewport);
    expect(before).not.toBeNull();
    expect(await distanceFromBottom(viewport)).toBeGreaterThan(200);
    const anchorId = before?.id ?? "";
    const anchorOffset = before?.offset ?? 0;

    await page.reload();
    await expect(viewport.getByText("ROW-39 lorem")).toBeVisible({ timeout: 60_000 });
    // The same message sits at the same offset once the rows have taken their real heights.
    await expect
      .poll(
        async () => {
          const offset = await offsetOf(viewport, anchorId);
          return offset === null ? Number.POSITIVE_INFINITY : Math.abs(offset - anchorOffset);
        },
        { timeout: 15_000 },
      )
      .toBeLessThanOrEqual(8);
    expect(await distanceFromBottom(viewport)).toBeGreaterThan(200);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-838-rows-after-reload.png") });
  },
);
