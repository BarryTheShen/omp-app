/// <reference types="node" />
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
 * The fake model answers `run_queued_pair` with one assistant message: a thought, then a bash that sleeps 20 s and
 * a write that waits for it. The page misses that message's end (its message_end), so the store keeps the message
 * as a streaming copy. The gap opens when the bash starts, and the history reload that closes it runs while the
 * bash still sleeps. The history holds the ended message, so the message must stop streaming then: its thought
 * shimmers only while the message streams, so the shimmer stops during the bash. Both calls then end with results.
 */
const BASH = "tool-card-call_queued_bash";
const WRITE = "tool-card-call_queued_write";

/** The frame's `payload` as an RPC session event, or undefined when the frame carries none. */
function payloadOf(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  return typeof frame.payload === "object" && frame.payload !== null
    ? (frame.payload as Record<string, unknown>)
    : undefined;
}

/** Drops the first assistant message_end the run sends after the prompt: the page never sees that message's last update. */
async function missedMessageEnd(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    let promptSent = false;
    let dropped = false;
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (frame.type === "call" && frame.port === "A0.chatSession" && frame.method === "request") {
        const args = (frame.args ?? {}) as { method?: string };
        if (args.method === "prompt") promptSent = true;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      const payload = payloadOf(frame);
      const event = (payload?.event ?? {}) as { type?: unknown; message?: { role?: unknown } };
      const assistantEnd =
        payload?.kind === "event" &&
        event.type === "message_end" &&
        event.message?.role === "assistant";
      if (frame.type === "event" && promptSent && !dropped && assistantEnd) {
        dropped = true;
        return;
      }
      ws.send(message);
    });
  });
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

realTest.setTimeout(420_000);

realTest(
  "a message whose last update the page missed stops streaming while its bash runs, and its cards render",
  async ({ realApp }) => {
    const page = await realApp.open({ beforeLoad: (page) => missedMessageEnd(page) });
    const composer = await startChat(page);
    // The chat has loaded (the thread shows its empty state, not "Loading conversation"): a prompt typed while it
    // loads is lost when the draft loads.
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await sendPrompt(composer, "run_queued_pair");

    const bash = page.getByTestId(BASH);
    const write = page.getByTestId(WRITE);
    await expect(bash).toHaveAttribute("data-phase", "running", { timeout: 60_000 });
    // The thought belongs to the message whose end the page missed. The reload that closes the gap runs while the
    // bash sleeps, so the thought must stop shimmering well before the bash ends (20 s).
    const thought = page.getByRole("button", { name: /^Thought/ }).first();
    await expect(thought).toBeVisible({ timeout: 30_000 });
    await expect(thought).not.toHaveClass(/shimmer/, { timeout: 10_000 });
    await expect(bash).toHaveAttribute("data-phase", "running");

    // Both calls end with their results, and the chat settles.
    await expect(bash).toHaveAttribute("data-phase", "success", { timeout: 180_000 });
    await expect(write).toHaveAttribute("data-phase", "success", { timeout: 180_000 });
    await expect(bash).toContainText("Complete");
    await expect(write).toContainText("Complete");
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 60_000 });

    await bash.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-899-settled-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-899-settled-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await bash.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-899-settled-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
