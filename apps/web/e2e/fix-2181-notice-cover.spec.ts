import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  APP_ROOT,
  expect,
  REAL_OMP,
  realTest,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

// Issue 2181: a chat's notices take their own row above the composer. They cover no message or control, they do not move
// the composer, a repeat of the same notice is one entry with its count, and a chat shows only its own notices.
const EXTENSION_FILE = "notice-cover-2181.ts";
const EXTENSION_SOURCE = `export default function noticeCover2181(pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("xd://: mounted mcp__notion_fetch, mcp__notion_search", "info");
    ctx.ui.notify("Build cache warmed", "info");
  });
  pi.on("turn_start", (_event, ctx) => {
    ctx.ui.notify("Disk is almost full on the build volume", "warning");
  });
  pi.on("agent_end", (_event, ctx) => {
    ctx.ui.notify("Turn notice from the 2181 extension", "error");
  });
}
`;
const DATA_DIR = join(APP_ROOT, ".data");
mkdirSync(DATA_DIR, { recursive: true });
const OMP_WITH_EXTENSION = join(DATA_DIR, "omp-app-2181-omp-with-extension.sh");
writeFileSync(
  OMP_WITH_EXTENSION,
  `#!/bin/sh\nexec '${REAL_OMP}' --extension "$PI_CODING_AGENT_DIR/extensions/${EXTENSION_FILE}" "$@"\n`,
);
chmodSync(OMP_WITH_EXTENSION, 0o755);

realTest.use({
  ompBinary: OMP_WITH_EXTENSION,
  seedExtensions: { [EXTENSION_FILE]: EXTENSION_SOURCE },
});
realTest.setTimeout(900_000);

declare global {
  interface Window {
    __ncShift?: { total: number };
  }
}

/** Runs before the app: totals the layout shift the page reports, so a notice's movement can be checked. */
function recordShift(): void {
  const shift = { total: 0 };
  window.__ncShift = shift;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!Reflect.get(entry, "hadRecentInput")) shift.total += Number(Reflect.get(entry, "value"));
    }
  }).observe({ type: "layout-shift", buffered: true });
}

type Theme = "light" | "dark";

/** Before the app loads: the theme the person chose, and the shift recorder. */
async function prepare(target: Page, theme: Theme): Promise<void> {
  await target.addInitScript(recordShift);
  await target.addInitScript((value: string) => {
    window.localStorage.setItem("omp-app.theme", value);
  }, theme);
}

/** Starts a chat at any width: the narrow layout keeps the sessions list in a drawer that must open first. */
async function startChatAt(page: Page, width: number): Promise<Locator> {
  if (width <= 768) {
    // The layout changes after the resize: wait for the button before opening the drawer, so a wide layout that has
    // not gone yet is not taken for an open drawer (fix-1201-session-title-card-real.spec.ts does the same, issue 1450).
    const show = page.getByRole("button", { name: "Show sessions sidebar" });
    await expect(show).toBeVisible();
    await show.click();
  }
  const composer = await startChat(page);
  if (width <= 768) {
    const close = page.locator('button[aria-label="Close open sidebar"]');
    if ((await close.count()) > 0) await close.click();
  }
  await waitForFiniteAnimations(page);
  return composer;
}

/** Sends a prompt and waits for its reply: a new message row beyond the person's own, and the stop button gone. */
async function sendAndWait(page: Page, composer: Locator, text: string): Promise<void> {
  const rows = page.locator('[data-slot="u1-message-row"]');
  const before = await rows.count();
  await sendPrompt(composer, text);
  await expect.poll(() => rows.count(), { timeout: 120_000 }).toBeGreaterThan(before + 1);
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
    timeout: 120_000,
  });
  await page.waitForTimeout(800);
  await waitForFiniteAnimations(page);
}

interface Cover {
  readonly samples: number;
  readonly covered: number;
}

/**
 * How many points of a 5 x 5 grid over `target` (clipped to `within`, when given) are drawn over by the notices or by the
 * empty-chat overlay. A notice in its own row covers none of them.
 */
async function coverOf(page: Page, target: Locator, within?: Locator): Promise<Cover> {
  const raw = await target.boundingBox();
  if (raw === null) throw new Error("the element to check is not drawn");
  const frame = within ? await within.boundingBox() : null;
  const left = frame ? Math.max(raw.x, frame.x) : raw.x;
  const top = frame ? Math.max(raw.y, frame.y) : raw.y;
  const right = frame ? Math.min(raw.x + raw.width, frame.x + frame.width) : raw.x + raw.width;
  const bottom = frame ? Math.min(raw.y + raw.height, frame.y + frame.height) : raw.y + raw.height;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < 5; i += 1) {
    for (let j = 0; j < 5; j += 1) {
      points.push({
        x: left + ((right - left) * (i + 0.5)) / 5,
        y: top + ((bottom - top) * (j + 0.5)) / 5,
      });
    }
  }
  const covered = await page.evaluate(
    (list) =>
      list.filter(({ x, y }) =>
        Boolean(
          document
            .elementFromPoint(x, y)
            ?.closest('[data-shell-region="notices"], [data-layout-area="threadOverlay"]'),
        ),
      ).length,
    points,
  );
  return { samples: points.length, covered };
}

async function composerTop(page: Page): Promise<number> {
  const box = await page.locator('[data-shell-region="composer"]').boundingBox();
  if (box === null) throw new Error("the composer is not drawn");
  return box.y;
}

async function shiftSoFar(page: Page): Promise<number> {
  return page.evaluate(() => window.__ncShift?.total ?? 0);
}

realTest(
  "a chat's notices take their own row above the composer, cover nothing, and leave the composer in place",
  async ({ realApp }) => {
    const page = await realApp.open({ beforeLoad: (target) => prepare(target, "light") });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChatAt(page, 1280);
    const toggle = page.getByRole("button", { name: /^\d+ notices? from omp$/ });
    await expect(toggle).toBeVisible({ timeout: 120_000 });
    await sendAndWait(page, composer, "pong");
    await sendAndWait(page, composer, "long_reply_probe");

    // The notices sit in their own row, above the composer, and not over the empty-chat overlay.
    const row = page.locator('[data-shell-region="notices"]');
    await expect(row.locator('[data-testid="n1-notices"]')).toBeVisible();
    await expect(
      page.locator('[data-layout-area="threadOverlay"] [data-testid="n1-notices"]'),
    ).toHaveCount(0);
    const rowBox = await row.boundingBox();
    expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual(await composerTop(page));

    // The warning and the error sent on each turn are each one entry in the notices, counted twice.
    await expect(row.getByText(/^Disk is almost full on the build volume/)).toHaveCount(1);
    await expect(row.getByText("×2", { exact: true })).toHaveCount(2);

    // Nothing is drawn over the last message, the composer or its send button.
    const viewport = page.locator('[data-slot="u1-thread-viewport"]');
    const lastMessage = page.locator('[data-slot="u1-message-row"]').last();
    expect((await coverOf(page, lastMessage, viewport)).covered).toBe(0);
    expect((await coverOf(page, composer)).covered).toBe(0);
    expect((await coverOf(page, page.locator('button[aria-label="Send message"]'))).covered).toBe(
      0,
    );

    // Opening and closing the notices moves neither the composer nor the page.
    const topBefore = await composerTop(page);
    const shiftBefore = await shiftSoFar(page);
    await toggle.click();
    await waitForFiniteAnimations(page);
    expect(Math.abs((await composerTop(page)) - topBefore)).toBeLessThanOrEqual(1);
    await toggle.click();
    await waitForFiniteAnimations(page);
    expect(Math.abs((await composerTop(page)) - topBefore)).toBeLessThanOrEqual(1);
    expect((await shiftSoFar(page)) - shiftBefore).toBeLessThan(0.02);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "on a phone, the notices of a long chat cover no message and the composer does not move",
  async ({ realApp }) => {
    const page = await realApp.open({ beforeLoad: (target) => prepare(target, "dark") });
    await page.setViewportSize({ width: 390, height: 844 });
    const composer = await startChatAt(page, 390);
    const toggle = page.getByRole("button", { name: /^\d+ notices? from omp$/ });
    await expect(toggle).toBeVisible({ timeout: 120_000 });
    await sendAndWait(page, composer, "long_reply_probe");

    const viewport = page.locator('[data-slot="u1-thread-viewport"]');
    const lastMessage = page.locator('[data-slot="u1-message-row"]').last();
    expect((await coverOf(page, lastMessage, viewport)).covered).toBe(0);
    expect((await coverOf(page, composer)).covered).toBe(0);

    const topBefore = await composerTop(page);
    const shiftBefore = await shiftSoFar(page);
    await toggle.click();
    await waitForFiniteAnimations(page);
    expect(Math.abs((await composerTop(page)) - topBefore)).toBeLessThanOrEqual(1);
    expect((await shiftSoFar(page)) - shiftBefore).toBeLessThan(0.02);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a pending message under the retry banner is not covered, and a second chat does not carry the first chat's banner",
  async ({ realApp }) => {
    const page = await realApp.open({ beforeLoad: (target) => prepare(target, "dark") });
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChatAt(page, 1280);
    const toggle = page.getByRole("button", { name: /^\d+ notices? from omp$/ });
    await expect(toggle).toBeVisible({ timeout: 120_000 });
    await sendAndWait(page, composer, "long_reply_probe");
    await sendPrompt(composer, "retry_failure_probe");

    const banner = page.locator('section[aria-label="Important notices"]');
    await expect(banner).toBeVisible({ timeout: 120_000 });
    const viewport = page.locator('[data-slot="u1-thread-viewport"]');
    const pending = page.locator('[data-slot="u1-message-row"]').last();
    expect((await coverOf(page, pending, viewport)).covered).toBe(0);

    // A second chat is a chat of its own: it opens empty, and the first chat's banner is not carried into it.
    await startChatAt(page, 1280);
    await expect(page.locator('[data-slot="u1-thread-empty"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('article[data-notification-placement="banner"]')).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(toggle).toBeVisible({ timeout: 120_000 });
    expect(realApp.problems).toEqual([]);
  },
);
