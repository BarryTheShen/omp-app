import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator } from "@playwright/test";
import { sessionBucketName } from "../../../packages/server/src/modules/A1/sessions/paths";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * Issue #838, review of PR #891. A saved place can be older than the newest window of history. The chat opens
 * with its newest messages; the reader pages the oldest one in and reads it from the top. After a reload the
 * app must page that message in again and put the reader back on it, not at the bottom of the chat.
 */
const MESSAGE_CHARACTERS = 1_500_000;
const VIEWPORT = '[data-slot="u1-thread-viewport"]';

function sessionLines(folder: string): string[] {
  const header = {
    type: "session",
    version: 3,
    id: "fix-838-windowed-e2e",
    timestamp: "2026-10-05T00:00:00.000Z",
    cwd: folder,
  };
  const markers = ["OLDEST-MARK", "MIDDLE-MARK", "NEWEST-MARK"];
  const body = "lorem ipsum ".repeat(Math.ceil(MESSAGE_CHARACTERS / 12));
  const entries = markers.map((marker, index) => ({
    type: "message",
    id: `windowed-${index + 1}`,
    parentId: index === 0 ? null : `windowed-${index}`,
    timestamp: `2026-10-05T00:00:0${index + 1}.000Z`,
    message: { role: "user", content: `${marker} ${body}`, timestamp: index + 1 },
  }));
  return [header, ...entries].map((line) => JSON.stringify(line));
}

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

async function twoFrames(viewport: Locator): Promise<void> {
  await viewport.evaluate(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    await promise;
  });
}

realTest(
  "a reload pages the oldest message back in and returns the reader to it, not to the bottom",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const root = dirname(realApp.folder);
    const home = join(root, "home");
    const bucket = join(root, "agent", "sessions", sessionBucketName(realApp.folder, { home }));
    await mkdir(bucket, { recursive: true });
    await writeFile(
      join(bucket, "2026-10-05T00-00-00-000Z_fix-838-windowed-e2e.jsonl"),
      `${sessionLines(realApp.folder).join("\n")}\n`,
    );

    const page = await realApp.open();
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 60_000 });
    await list.getByRole("option").first().click();
    const viewport = page.locator(VIEWPORT);
    await expect(viewport.getByText("NEWEST-MARK")).toBeVisible({ timeout: 60_000 });
    await expect(viewport.getByText("OLDEST-MARK")).toHaveCount(0);

    // Page the oldest message in with the button, as a person would. A script click keeps the reader's place.
    const earlier = page.getByRole("button", { name: "Show earlier messages" });
    await expect(earlier).toBeVisible({ timeout: 60_000 });
    await earlier.evaluate((button) => {
      if (button instanceof HTMLElement) {
        button.focus({ preventScroll: true });
        button.click();
      }
    });
    await expect(viewport.getByText("OLDEST-MARK")).toBeVisible({ timeout: 60_000 });

    // Read from the top of the transcript, where the oldest message starts.
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await twoFrames(viewport);
    const before = await anchorOf(viewport);
    expect(before).not.toBeNull();
    expect(await distanceFromBottom(viewport)).toBeGreaterThan(500);
    const anchorId = before?.id ?? "";
    const anchorOffset = before?.offset ?? 0;

    await page.reload();
    // The oldest message is not in the newest window: it must be paged in, and the reader placed on it.
    await expect(viewport.getByText("OLDEST-MARK")).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(
        async () => {
          const offset = await offsetOf(viewport, anchorId);
          return offset === null ? Number.POSITIVE_INFINITY : Math.abs(offset - anchorOffset);
        },
        { timeout: 30_000 },
      )
      .toBeLessThanOrEqual(8);
    expect(await distanceFromBottom(viewport)).toBeGreaterThan(500);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-838-windowed-after-reload.png") });
  },
);
