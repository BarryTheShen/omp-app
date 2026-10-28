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
 * Motion (#1173, part 5, #1209): a new message and a new session row fade in once when they arrive, and a removed
 * session row fades out. History that loads, and a reload, fade nothing; reduced motion turns every fade off. The page
 * records each opacity transition that starts on a row, by kind and direction: "enter" when the row is drawn, "leave"
 * when it is given the leaving opacity.
 */

declare global {
  interface Window {
    __fades?: string[];
    __inserts?: Record<string, number>;
  }
}

/**
 * Runs in the page before any script: records each opacity transition that starts on a row, and each session or running
 * row the page draws (`__inserts`), so a row that appears without its fade is a difference between the two.
 */
function recordFades(): void {
  const fades: string[] = [];
  const inserts: Record<string, number> = {};
  window.__fades = fades;
  window.__inserts = inserts;
  const kindOf = (element: Element): string | null => {
    if (element.matches('[data-slot="r1-session-row"]')) return "session";
    if (element.matches('[data-slot="r1-running-row"]')) return "running";
    return null;
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const element of [node, ...Array.from(node.querySelectorAll("*"))]) {
          const kind = kindOf(element);
          if (kind !== null) inserts[kind] = (inserts[kind] ?? 0) + 1;
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener("transitionrun", (event) => {
    if (event.propertyName !== "opacity") return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const direction = target.classList.contains("opacity-0") ? "leave" : "enter";
    if (target.matches('[data-slot="u1-message-row"]')) fades.push(`message:${direction}`);
    else if (target.matches('[data-slot="r1-session-row"]')) fades.push(`session:${direction}`);
    else if (target.matches('[data-slot="r1-running-row"]')) fades.push(`running:${direction}`);
  });
}

/** The transitions recorded so far, counted by kind and direction, for example "message:enter". */
async function fadeCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const counts: Record<string, number> = {};
    for (const entry of window.__fades ?? []) counts[entry] = (counts[entry] ?? 0) + 1;
    return counts;
  });
}

/** The session and running rows the page has drawn, by kind (a row is counted each time the page inserts it). */
async function insertCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...(window.__inserts ?? {}) }));
}

/** Turns the theme on or off the way the Settings toggle does: the root's `dark` class, then the page settles. */
async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

/** The newest assistant row in the transcript: the reply to the prompt the test sent. */
function replyRow(page: Page) {
  return page.locator('[data-slot="u1-message-row"][data-role="assistant"]').last();
}

realTest.describe("history", () => {
  realTest.use({
    seedEntries: {
      entries: Array.from({ length: 20 }, (_, index) => [
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: `Earlier question ${index + 1}` }],
            timestamp: Date.UTC(2026, 9, 10, 9, index),
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Earlier answer ${index + 1}` }],
            api: "openai-completions",
            provider: "fake",
            model: "fake-model",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.UTC(2026, 9, 10, 9, index, 30),
          },
        },
      ]).flat(),
    },
  });

  realTest("history that loads, and a reload, fades nothing", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({ beforeLoad: (target) => target.addInitScript(recordFades) });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("Earlier answer 20", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await waitForFiniteAnimations(page);
    expect(await fadeCounts(page), "fades while history loads").toEqual({});

    await page.reload();
    await expect(page.getByText("Earlier answer 20", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await waitForFiniteAnimations(page);
    expect(await fadeCounts(page), "fades after a reload").toEqual({});
  });
});

realTest(
  "a new chat's first message fades its rows in once, and is captured in light and dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({ beforeLoad: (target) => target.addInitScript(recordFades) });
    // The list has loaded before the chat starts: a chat that is listed by the load is history, not a new row.
    await expect(page.getByText("No sessions in this folder")).toBeVisible({ timeout: 60_000 });
    const composer = await startChat(page);
    await sendPrompt(composer, "pong");
    await expect(replyRow(page)).toContainText("pong", { timeout: 60_000 });
    await waitForFiniteAnimations(page);
    const fades = await fadeCounts(page);
    const inserted = await insertCounts(page);
    // A row that appears fades in once. A running row stands for a chat whose session file is not written yet; the saved
    // row then keeps its element (both are keyed by the chat's id, #2212), so it is not drawn or faded again. When omp
    // writes the file before the list shows the chat running, no running row appears, and the saved row is the new row.
    const running = inserted.running ?? 0;
    expect(running + (inserted.session ?? 0), "the new chat's row appears once").toBe(1);
    expect(fades, "each new row fades in once").toEqual({
      "message:enter": 2,
      ...(running === 1 ? { "running:enter": 1 } : { "session:enter": 1 }),
    });
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "motion-rows-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "motion-rows-dark.png") });
  },
);

realTest("a new message at 390 px is captured in light and dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open({ beforeLoad: (target) => target.addInitScript(recordFades) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show sessions sidebar" }).click();
  const composer = await startChat(page);
  const drawerClose = page.locator('button[aria-label="Close open sidebar"]');
  if ((await drawerClose.count()) > 0) await drawerClose.click();
  await sendPrompt(composer, "pong");
  await expect(replyRow(page)).toContainText("pong", { timeout: 60_000 });
  await waitForFiniteAnimations(page);
  expect((await fadeCounts(page))["message:enter"], "the reply fades in once at 390 px").toBe(2);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "motion-rows-390-light.png") });
  await setTheme(page, true);
  await page.screenshot({ path: join(screenshots, "motion-rows-390-dark.png") });
});

realTest.describe("with reduced motion", () => {
  realTest("a new message and a new session row do not fade", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.emulateMedia({ reducedMotion: "reduce" });
        await target.addInitScript(recordFades);
      },
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "pong");
    await expect(replyRow(page)).toContainText("pong", { timeout: 60_000 });
    await waitForFiniteAnimations(page);
    expect(await fadeCounts(page), "fades under reduced motion").toEqual({});
  });
});

realTest(
  "a running first reply's row fades in once, and does not fade again when a reload brings it back during the run",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({ beforeLoad: (target) => target.addInitScript(recordFades) });
    await expect(page.getByText("No sessions in this folder")).toBeVisible({ timeout: 60_000 });
    const composer = await startChat(page);
    await sendPrompt(composer, "stream_long_code please");
    const running = page.locator('[data-slot="r1-running-row"]');
    await expect(running).toHaveCount(1, { timeout: 30_000 });
    await waitForFiniteAnimations(page);
    expect((await fadeCounts(page))["running:enter"], "the running row fades in once").toBe(1);

    await page.reload();
    await expect(running).toHaveCount(1, { timeout: 30_000 });
    await waitForFiniteAnimations(page);
    expect(
      (await fadeCounts(page))["running:enter"] ?? 0,
      "a running row a reload brings back does not fade",
    ).toBe(0);
  },
);

realTest.describe("removing a chat", () => {
  realTest.use({ seedSessions: 3 });

  realTest(
    "a deleted chat's row fades out once, then leaves the list",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(240_000);
      const page = await realApp.open({
        beforeLoad: (target) => target.addInitScript(recordFades),
      });
      const row = page
        .getByRole("listbox", { name: "Session list" })
        .getByRole("option", { name: /^Seeded chat 2/ });
      await expect(row).toBeVisible({ timeout: 60_000 });
      await page.getByRole("button", { name: "More actions for Seeded chat 2" }).click();
      await page
        .getByRole("menu", { name: "Actions for Seeded chat 2" })
        .getByRole("menuitem", { name: "Delete Seeded chat 2" })
        .click();
      await page
        .getByRole("dialog", { name: "Delete chat" })
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await expect(
        page.locator('[data-slot="r1-session-row"]', { hasText: "Seeded chat 2" }),
      ).toHaveCount(0, { timeout: 10_000 });
      expect(await fadeCounts(page), "the deleted row fades out once").toEqual({
        "session:leave": 1,
      });
    },
  );
});
