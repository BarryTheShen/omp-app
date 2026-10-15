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
 * Issue 1359 on real omp. Picking the chat that is already open used to close it and open it again: omp was asked to
 * open it, the transcript reloaded from the start, and its open folds and scroll position went. The pick now does
 * nothing. The chat is the seeded session file `seedLongTurn: 200`, as in long-turn.spec.ts.
 */
realTest.use({ seedLongTurn: 200 });

/**
 * How long a pick is watched before the transcript is read. A reopen, when a pick causes one, follows omp's answer to
 * the pick within a round trip to the local server; the window is far longer than that, so the reopen has happened by
 * the time the transcript is read. The frame check in the other test does not depend on it: it reads the frames in order.
 */
const PICK_SETTLE_MS = 2_000;

/** Logs every frame the page sends to the server. The frames pass through unchanged. */
function logFrames(page: Page, sent: string[]): Promise<void> {
  return page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      sent.push(String(message));
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
}

/** The thread ids of the calls to `method` among these frames, in order. */
function threadsOf(frames: readonly string[], method: "open" | "close"): string[] {
  return frames.flatMap((frame) => {
    if (!frame.includes(`"method":"${method}"`)) return [];
    return [...frame.matchAll(/"threadId":"([^"]+)"/g)].map((match) => match[1] ?? "");
  });
}

realTest("picking the chat that is already open sends nothing to omp", async ({ realApp }) => {
  const sent: string[] = [];
  const page = await realApp.open({ beforeLoad: (target) => logFrames(target, sent) });
  await page.setViewportSize({ width: 1280, height: 900 });
  const row = page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: /Run the long job/ });
  await row.click();
  await expect(page.getByRole("button", { name: /earlier steps/ })).toHaveText(
    "181 earlier steps",
    {
      timeout: 60_000,
    },
  );
  const chat = threadsOf(sent, "open")[0] ?? "";
  expect(chat).not.toBe("");

  // The pick under test. A New chat is opened right after it: its open frame is the barrier, because the page sends its
  // frames in order, so every frame the pick sent is on the wire before the New chat's open frame.
  const mark = sent.length;
  await row.click();
  await page
    .locator('[aria-label="Sessions"]')
    .getByRole("button", { name: "New chat" })
    .first()
    .click();
  await expect
    .poll(() => sent.slice(mark).some((frame) => frame.includes('"start":"new"')))
    .toBe(true);
  const frames = sent.slice(mark);
  const newChatAt = frames.findIndex((frame) => frame.includes('"start":"new"'));
  const beforeNewChat = frames.slice(0, newChatAt);
  expect(
    beforeNewChat.filter(
      (frame) => frame.includes('"method":"open"') || frame.includes('"method":"close"'),
    ),
    "the open and close calls the pick sent",
  ).toEqual([]);
  expect(threadsOf(frames, "open")).not.toContain(chat);
  await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
  expect(realApp.problems).toEqual([]);
});

realTest(
  "picking the chat that is already open keeps its folds, its scroll position and its row",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /Run the long job/ });
    await row.click();

    const fold = page.getByRole("button", { name: /earlier steps/ });
    await expect(fold).toHaveText("181 earlier steps", { timeout: 60_000 });
    const cards = page.locator('[data-slot="u3-bash-card"]');
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(cards).toHaveCount(19 + 50);

    // The reader scrolls to the middle of the transcript, away from the newest step.
    const viewport = page.getByRole("region", { name: "Messages" });
    const middle = await viewport.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      return element.scrollTop;
    });
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(middle);

    // The state the pick must keep, as a person sees it: the chat open with its earlier steps open.
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1359-before-light.png") });

    // The pick under test, then the time a reopen would take to show.
    await row.click();
    await page.evaluate(
      (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      PICK_SETTLE_MS,
    );

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(cards).toHaveCount(19 + 50);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(middle);

    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1359-after-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1359-after-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    // At 390 px both sidebars are drawers: wait until both report closed before the narrow capture.
    await expect(page.locator("#shell-sessions-sidebar")).toHaveAttribute("inert", "");
    await expect(page.locator("#shell-panels-sidebar")).toHaveAttribute("inert", "");
    await expect(page.locator('[data-shell-drawer-backdrop="true"]')).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1359-after-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "picking the chat whose turn is running sends nothing to omp, and the turn ends in the same chat",
  async ({ realApp }) => {
    const sent: string[] = [];
    const page = await realApp.open({ beforeLoad: (target) => logFrames(target, sent) });
    const composer = await startChat(page);
    await sendPrompt(composer, "slow_tool pick");
    const stop = page.getByRole("button", { name: "Stop generating" });
    await expect(stop).toBeVisible({ timeout: 60_000 });

    // The chat's turn runs seven seconds, so the pick's frames are on the wire long before the turn ends.
    const mark = sent.length;
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /slow_tool pick/ })
      .click();
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
    expect(
      sent
        .slice(mark)
        .filter((frame) => frame.includes('"method":"open"') || frame.includes('"method":"close"')),
      "the open and close calls the pick sent",
    ).toEqual([]);
    await expect(
      page
        .getByRole("region", { name: "Conversation transcript" })
        .getByText("slow_tool pick", { exact: true }),
    ).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);
