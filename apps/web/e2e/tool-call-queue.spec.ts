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
 * A bash call, then a write, in one message. Bash runs alongside other shared calls, but write is exclusive,
 * so omp starts it only when the bash has finished: while the bash runs, the write is queued. The bash must
 * read Running from the start of its command, and the queued write must read Waiting, never Finished, No
 * result recorded or Streaming, and both calls end with their results.
 *
 * The page's WebSocket makes the store refetch the chat's history during the run, as a busy machine can: the
 * assistant message's start never reaches the page (a gap in the stream), so the store refetches, and the
 * refetch's get_state answer is held for REFETCH_MS. The bash starts inside that refetch, and its start must
 * still be shown.
 */

const BASH = "tool-card-call_queued_bash";
const WRITE = "tool-card-call_queued_write";
const REFETCH_MS = 1_500;

/** The frame's `payload` as an RPC session event, or undefined when the frame carries none. */
function payloadOf(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  return typeof frame.payload === "object" && frame.payload !== null
    ? (frame.payload as Record<string, unknown>)
    : undefined;
}

/**
 * Drops the start of the run's assistant message, then holds the answer to the get_state the gap starts (the
 * refetch's first read) for REFETCH_MS. `answered` runs once that held answer has been delivered to the page.
 */
async function missedStartThenSlowRefetch(page: Page, answered: () => void): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    let promptSent = false;
    let dropped = false;
    let refetchCall: string | undefined;
    let held = false;
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (frame.type === "call" && frame.method === "send") {
        const args = (frame.args ?? {}) as { command?: { type?: string } };
        if (args.command?.type === "prompt") promptSent = true;
        if (dropped && !held && refetchCall === undefined && args.command?.type === "get_state") {
          refetchCall = String(frame.id);
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      const payload = payloadOf(frame);
      const event = (payload?.event ?? {}) as { type?: unknown; message?: { role?: unknown } };
      const assistantStart =
        payload?.kind === "omp" &&
        event.type === "message_start" &&
        event.message?.role === "assistant";
      if (frame.type === "event" && promptSent && !dropped && assistantStart) {
        dropped = true;
        return;
      }
      if (frame.type === "result" && refetchCall !== undefined && frame.id === refetchCall) {
        held = true;
        refetchCall = undefined;
        setTimeout(() => {
          ws.send(message);
          answered();
        }, REFETCH_MS);
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
  "a call omp has not started reads Waiting while the call before it runs, and both calls end with their results",
  async ({ realApp }) => {
    const { promise: refetchAnswered, resolve: answered } = Promise.withResolvers<void>();
    const page = await realApp.open({
      beforeLoad: (page) => missedStartThenSlowRefetch(page, answered),
    });
    const composer = await startChat(page);
    // The chat's history has loaded (the thread shows its empty state, not "Loading conversation"): the run starts
    // from a settled chat, and the refetch that follows is the one this test holds.
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await sendPrompt(composer, "run_queued_pair");

    const bash = page.getByTestId(BASH);
    const write = page.getByTestId(WRITE);
    // The bash runs as soon as omp starts it, inside the refetch that the missed event started.
    await expect(bash).toHaveAttribute("data-phase", "running", { timeout: 10_000 });
    await expect(bash).toContainText("Running");

    // While the bash runs, the write has no state yet: it is queued, and its card says Waiting. The same holds
    // once the held refetch answer has been delivered.
    await expect(write).toHaveAttribute("data-queued", "true", { timeout: 30_000 });
    await refetchAnswered;
    await expect(bash).toHaveAttribute("data-phase", "running");
    await expect(write).toHaveAttribute("data-queued", "true");
    await expect(write).toContainText("Waiting");
    await expect(write).not.toContainText("Finished");
    await expect(write).not.toContainText("No result recorded");
    await expect(write).not.toContainText("Streaming");
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "tool-call-queue-waiting-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "tool-call-queue-waiting-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(write).toHaveAttribute("data-queued", "true");
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "tool-call-queue-waiting-narrow.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });

    // Both calls end with their results: the write runs after the bash, and no card is left queued.
    await expect(bash).toHaveAttribute("data-phase", "success", { timeout: 180_000 });
    await expect(write).toHaveAttribute("data-phase", "success", { timeout: 180_000 });
    await expect(write).not.toHaveAttribute("data-queued", "true");
    await expect(bash).toContainText("Complete");
    await expect(write).toContainText("Complete");
    expect(realApp.problems).toEqual([]);
  },
);
