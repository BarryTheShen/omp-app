import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1359 on real omp. Picking the chat that is already open used to close it and open it again: omp was asked to
 * open it, the transcript reloaded from the start, and its open folds and scroll position went. Now the pick does
 * nothing. The check reads the frames the page sends: a New chat is opened right after the pick, and that open is the
 * barrier; no `open` for the chat may go out in between. The chat is the seeded session file `seedLongTurn: 200`, as
 * in long-turn.spec.ts.
 */
realTest.use({ seedLongTurn: 200 });

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

realTest(
  "picking the chat that is already open sends nothing: its folds and transcript stay as they were",
  async ({ realApp }) => {
    const sent: string[] = [];
    const page = await realApp.open({ beforeLoad: (target) => logFrames(target, sent) });
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
    const chat = threadsOf(sent, "open")[0] ?? "";
    expect(chat).not.toBe("");

    // The state the pick must keep, as a person sees it: the chat open with its earlier steps open.
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1359-open-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1359-open-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    // At 390 px both sidebars are drawers: wait until both report closed before the narrow capture.
    await expect(page.locator("#shell-sessions-sidebar")).toHaveAttribute("inert", "");
    await expect(page.locator("#shell-panels-sidebar")).toHaveAttribute("inert", "");
    await expect(page.locator('[data-shell-drawer-backdrop="true"]')).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1359-open-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    // The pick under test. A New chat is opened right after it: that open is the barrier, so every frame the pick
    // sent is on the wire before it.
    const mark = sent.length;
    await row.click();
    await page
      .locator('[aria-label="Sessions"]')
      .getByRole("button", { name: "New chat" })
      .first()
      .click();
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    expect(threadsOf(sent.slice(mark), "open")).not.toContain(chat);
  },
);

realTest(
  "a pick of the chat already open, made while a New chat is still opening, keeps that chat on screen",
  async ({ realApp }) => {
    const sent: string[] = [];
    const page = await realApp.open({ beforeLoad: (target) => logFrames(target, sent) });
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /Run the long job/ });
    await row.click();
    const fold = page.getByRole("button", { name: /earlier steps/ });
    await expect(fold).toHaveText("181 earlier steps", { timeout: 60_000 });
    const chat = threadsOf(sent, "open")[0] ?? "";
    expect(chat).not.toBe("");

    // A New chat starts omp, and the open chat is picked before the new chat has opened. The pick is the newest, so its
    // open goes out at once. The new chat is let go once its open settles: that release names the new chat, not the pick.
    const mark = sent.length;
    await page
      .locator('[aria-label="Sessions"]')
      .getByRole("button", { name: "New chat" })
      .first()
      .click();
    await row.click();
    await expect
      .poll(() => threadsOf(sent.slice(mark), "close").some((id) => id !== chat), {
        timeout: 60_000,
      })
      .toBe(true);
    expect(threadsOf(sent.slice(mark), "open")).toContain(chat);
    await expect(fold).toHaveText("181 earlier steps");
    await expect(page.getByText("No messages yet.")).toHaveCount(0);
  },
);
