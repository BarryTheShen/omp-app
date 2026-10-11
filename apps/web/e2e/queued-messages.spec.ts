/// <reference types="node" />
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Messages sent during a run are queued and shown (#819). `run_queued_pair` runs a bash that sleeps 20 seconds,
 * so the run stays open while messages are queued. A follow-up (Ctrl+Enter) waits under "After this turn" until the
 * turn yields, with its own Remove and Promote buttons. A steer (Enter) goes out at the next tool boundary: omp
 * backgrounds the running bash for it, so the Steering lane empties at once and the bash returns early.
 */

const BASH = "tool-card-call_queued_bash";
const USER_ROWS = '[data-slot="u1-message-row"][data-role="user"]';
const QUEUE_SLOT = '[data-surface="queue"]';

realTest.setTimeout(420_000);

function queueBar(page: Page): Locator {
  return page.getByRole("complementary", { name: "Queued messages" });
}

function lane(page: Page, name: string): Locator {
  return queueBar(page).getByRole("region", { name });
}

function userRow(page: Page, text: string): Locator {
  return page.locator(USER_ROWS).filter({ hasText: text });
}

function rowIndex(rows: readonly string[], text: string): number {
  return rows.findIndex((row) => row.includes(text));
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

/** The bar starts a line of its own: its top edge is at or below the bottom of the input mode row, never beside it. */
async function expectOwnLine(page: Page): Promise<void> {
  const mode = await page.getByRole("group", { name: "Input mode" }).boundingBox();
  const bar = await queueBar(page).boundingBox();
  if (!mode || !bar) throw new Error("The input mode row or the queue bar has no box on the page");
  expect(bar.y).toBeGreaterThanOrEqual(mode.y + mode.height);
}

/** The card's background is the design token of the current theme, so a screenshot shows our styles, not browser defaults. */
async function expectCardToken(page: Page): Promise<void> {
  const matches = await queueBar(page).evaluate((bar) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--card)";
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return getComputedStyle(bar).backgroundColor === expected;
  });
  expect(matches).toBe(true);
}

/** Sends `run_queued_pair` and waits until the turn is in progress: the composer offers Stop while it runs. */
async function startQueuedRun(page: Page, composer: Locator): Promise<Locator> {
  await sendPrompt(composer, "run_queued_pair");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
    timeout: 120_000,
  });
  return page.getByTestId(BASH);
}

realTest(
  "with nothing running, Ctrl+Enter sends an ordinary message, and an empty queue takes no space",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    // Nothing is queued, so the queue's slot in the composer is not laid out at all.
    await expect(page.locator(QUEUE_SLOT)).toBeHidden();
    await composer.fill("idle check");
    await composer.press("Control+Enter");
    // Nothing is running, so the message is an ordinary turn: it is answered, and nothing is queued.
    await expect(userRow(page, "idle check")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(queueBar(page)).toHaveCount(0);
    await expect(page.locator(QUEUE_SLOT)).toBeHidden();
  },
);

realTest(
  "Ctrl+Enter queues a follow-up under After this turn, and Enter steers; the queue empties in order",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    const bash = await startQueuedRun(page, composer);

    await composer.fill("follow later please");
    await composer.press("Control+Enter");
    await expect(
      lane(page, "After this turn").getByText("follow later please", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove follow-up message: follow later please" }),
    ).toBeEnabled();
    // A follow-up waits for the turn to yield, so it does not cut the running bash short.
    await expect(bash).not.toHaveAttribute("data-phase", "success");
    await expect(userRow(page, "follow later please")).toHaveCount(0);
    await expectOwnLine(page);

    // Captured while the follow-up waits: light, then a 390 px phone width.
    await settle(page);
    await expectCardToken(page);
    await page.screenshot({ path: join(screenshots, "queued-messages-light.png"), fullPage: true });
    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await expectOwnLine(page);
    await page.screenshot({
      path: join(screenshots, "queued-messages-narrow.png"),
      fullPage: true,
    });
    if (desktop) await page.setViewportSize(desktop);

    await composer.fill("steer now please");
    await composer.press("Enter");
    // The steer reaches the transcript at the next tool boundary, and the bash returns early for it.
    await expect(userRow(page, "steer now please")).toBeVisible({ timeout: 30_000 });
    await expect(bash).toHaveAttribute("data-phase", "success", { timeout: 30_000 });
    // The follow-up goes out once the turn yields, after the steer, and the queue empties.
    await expect(userRow(page, "follow later please")).toBeVisible({ timeout: 60_000 });
    await expect(queueBar(page)).toHaveCount(0, { timeout: 60_000 });
    const rows = await page.locator(USER_ROWS).allInnerTexts();
    expect(rowIndex(rows, "steer now please")).toBeGreaterThanOrEqual(0);
    expect(rowIndex(rows, "follow later please")).toBeGreaterThan(
      rowIndex(rows, "steer now please"),
    );
  },
);

realTest("a queued follow-up is readable in dark mode", async ({ realApp }) => {
  // The saved theme is set before the page loads, the way a person who chose Dark gets it.
  const page = await realApp.open({
    beforeLoad: (openPage) =>
      openPage.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await startQueuedRun(page, composer);

  await composer.fill("follow later please");
  await composer.press("Control+Enter");
  await expect(
    lane(page, "After this turn").getByText("follow later please", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expectOwnLine(page);
  await settle(page);
  await expectCardToken(page);
  await page.screenshot({ path: join(screenshots, "queued-messages-dark.png"), fullPage: true });
});

realTest(
  "Remove takes a queued follow-up out for good, Promote sends another now, and the rest waits for the turn to yield",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    const bash = await startQueuedRun(page, composer);

    await composer.fill("keep first");
    await composer.press("Control+Enter");
    await composer.fill("drop this");
    await composer.press("Control+Enter");
    await composer.fill("promote me");
    await composer.press("Control+Enter");
    await expect(
      lane(page, "After this turn").getByText("promote me", { exact: true }),
    ).toBeVisible();
    await expectOwnLine(page);

    // Captured with three queued messages: light at desktop width, then at 390 px.
    await settle(page);
    await expectCardToken(page);
    await page.screenshot({
      path: join(screenshots, "queued-messages-three-light.png"),
      fullPage: true,
    });
    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await expectOwnLine(page);
    await page.screenshot({
      path: join(screenshots, "queued-messages-three-narrow.png"),
      fullPage: true,
    });
    if (desktop) await page.setViewportSize(desktop);

    await page.getByRole("button", { name: "Remove follow-up message: drop this" }).click();
    await expect(lane(page, "After this turn").getByText("drop this", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      lane(page, "After this turn").getByText("keep first", { exact: true }),
    ).toBeVisible();

    // Promote sends the message as steering now: the bash returns early for it, long before its 20 seconds end.
    await page.getByRole("button", { name: "Promote queued message: promote me" }).click();
    await expect(bash).toHaveAttribute("data-phase", "success", { timeout: 8_000 });
    await expect(userRow(page, "promote me")).toBeVisible({ timeout: 30_000 });
    // The other follow-up waits for the turn to yield and goes out after it; the removed one never does.
    await expect(userRow(page, "keep first")).toBeVisible({ timeout: 120_000 });
    await expect(queueBar(page)).toHaveCount(0, { timeout: 60_000 });
    const rows = await page.locator(USER_ROWS).allInnerTexts();
    expect(rowIndex(rows, "drop this")).toBe(-1);
    expect(rowIndex(rows, "keep first")).toBeGreaterThan(rowIndex(rows, "promote me"));
  },
);
