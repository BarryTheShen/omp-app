import type { Locator, Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/*
 * Issue 1047. When a finished turn's history reloaded, the thread re-keyed its messages: the streamed rows were removed
 * and added again, and the task card in them was replaced with them. This probe marks each message row and the task
 * card while the worker runs, then checks after the turn settled that every marked element is still in the page.
 */

interface ProbeWindow extends Window {
  __probedElements?: Element[];
}

realTest.setTimeout(420_000);

realTest(
  "real omp: a finished turn's history reload keeps every message row and the task card as the same elements",
  async ({ realApp }) => {
    const page: Page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_subagent");
    await expect(page.getByTestId("t5-task-card")).toBeVisible({ timeout: 120_000 });
    await page.evaluate(() => {
      (window as ProbeWindow).__probedElements = [
        ...Array.from(document.querySelectorAll("[data-message-id]")),
        ...Array.from(document.querySelectorAll('[data-testid="t5-task-card"]')),
      ];
    });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    // The history reload can land a few seconds after the turn shows settled, so the check waits for it.
    await page.waitForTimeout(3_000);
    const probe = await page.evaluate(() => {
      const elements = (window as ProbeWindow).__probedElements ?? [];
      return {
        probed: elements.length,
        replaced: elements.filter((element) => !element.isConnected).length,
      };
    });
    expect(probe.probed, "the probe marked the message rows and the task card").toBeGreaterThan(1);
    expect(
      probe.replaced,
      `${probe.replaced} of ${probe.probed} marked elements were replaced`,
    ).toBe(0);
    expect(realApp.problems).toEqual([]);
  },
);

/** The message rows of the transcript: each one's own element, whose store key is read from its attribute. */
const ROWS = '[data-slot="u1-message-row"]';

/** The store key and the offset from the top of the view of the message row at the middle of the view. */
async function readerRow(viewport: Locator): Promise<{ key: string; offset: number } | null> {
  return viewport.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const row = hit?.closest<HTMLElement>("[data-store-key]");
    if (row === null || row === undefined || !element.contains(row)) return null;
    return { key: row.dataset.storeKey ?? "", offset: row.getBoundingClientRect().top - box.top };
  });
}

/** The offset from the top of the view of the message row with this store key, or null when it is not drawn. */
async function offsetOfKey(viewport: Locator, key: string): Promise<number | null> {
  return viewport.evaluate((element, storeKey) => {
    const row = Array.from(element.querySelectorAll<HTMLElement>("[data-store-key]")).find(
      (candidate) => candidate.dataset.storeKey === storeKey,
    );
    return row === undefined
      ? null
      : row.getBoundingClientRect().top - element.getBoundingClientRect().top;
  }, key);
}

realTest("real omp: Edit and Regenerate are present right after a turn", async ({ realApp }) => {
  const page: Page = await realApp.open();
  const composer = await startChat(page);
  await sendPrompt(composer, "ping");
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
  const user = page.locator(`${ROWS}[data-role="user"]`).first();
  const reply = page.locator(`${ROWS}[data-role="assistant"]`).first();
  await user.hover();
  await expect(user.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await reply.hover();
  await expect(reply.getByRole("button", { name: "Regenerate response" })).toBeVisible();
  expect(realApp.problems).toEqual([]);
});

realTest(
  "real omp: a streamed chat's reading place survives a reload, and the same row is at the same offset",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page: Page = await realApp.open();
    const composer = await startChat(page);
    // A short view, so the six turns overflow it and the reader can be away from the bottom.
    await page.setViewportSize({ width: 1280, height: 480 });
    const replies = page.locator(`${ROWS}[data-role="assistant"]`);
    for (let turn = 1; turn <= 6; turn += 1) {
      await sendPrompt(composer, "ping");
      await expect(replies).toHaveCount(turn, { timeout: 60_000 });
    }
    const viewport = page.getByRole("region", { name: "Messages" });
    // The reader scrolls up to the middle of the transcript, away from the newest message.
    await viewport.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    });
    // A row's place is saved once its history has come back from the session file, a few seconds after the turns.
    await expect
      .poll(async () => (await readerRow(viewport))?.key ?? "", { timeout: 60_000 })
      .toMatch(/^entry:/);
    // The place is saved on the scroll's frame: two frames later it is on disk.
    await viewport.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const before = await readerRow(viewport);
    expect(before, "a row sits at the middle of the view before the reload").not.toBeNull();
    await page.reload();
    await expect(page.locator(`${ROWS}[data-role="assistant"]`)).toHaveCount(6, {
      timeout: 60_000,
    });
    await expect
      .poll(
        async () => {
          const offset = await offsetOfKey(viewport, before?.key ?? "");
          return offset === null ? Number.NaN : Math.abs(offset - (before?.offset ?? 0));
        },
        { timeout: 30_000 },
      )
      .toBeLessThanOrEqual(8);
    const distance = await viewport.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    );
    expect(distance, "the reader is not left at the bottom").toBeGreaterThan(50);
    expect(realApp.problems).toEqual([]);
  },
);
