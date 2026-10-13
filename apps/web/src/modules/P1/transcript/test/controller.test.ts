import type { ThreadMessageLike } from "@assistant-ui/react";
import { AppFailure } from "@omp-app/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TranscriptTail } from "../controller";
import { withLiveStatus } from "../messages";
import {
  agentRef,
  assistantMessage,
  FakeFeed,
  lifecycleEvent,
  nestedFrame,
  replacedFile,
  transcriptPage,
  userMessage,
} from "./fixtures";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs the timers that are due now, then the promise callbacks they start. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Advances to the next heartbeat. The heartbeat's read starts on a zero-delay timer that the advance
 * stops short of, so the helper settles once more before the test looks.
 */
async function toHeartbeat(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_000);
  await settle();
}

function tailFor(feed: FakeFeed): TranscriptTail {
  return new TranscriptTail({ feed, heartbeatMs: 2_000, minIntervalMs: 300 });
}

function oneMessage() {
  return transcriptPage({ fromByte: 0, nextByte: 40, messages: [userMessage("one")] });
}

/** Starts the tail and answers its first read with one message, so the cursor is at byte 40. */
async function startedWithOneMessage(feed: FakeFeed, tail: TranscriptTail): Promise<void> {
  tail.start();
  await settle();
  feed.answer(oneMessage());
  await settle();
}

describe("the transcript tail", () => {
  test("the first read starts at byte zero, and the transcript is shown once it arrives", async () => {
    const feed = new FakeFeed(agentRef());
    const tail = tailFor(feed);
    tail.start();
    await settle();
    expect(feed.requests).toEqual([0]);
    expect(tail.getView().loading).toBe(true);
    feed.answer(oneMessage());
    await settle();
    expect(tail.getView().loading).toBe(false);
    expect(tail.getView().messages).toHaveLength(1);
    tail.stop();
  });

  test("frames that arrive together become one read once the throttle interval has passed", async () => {
    const feed = new FakeFeed(agentRef());
    const tail = tailFor(feed);
    await startedWithOneMessage(feed, tail);
    feed.emit(nestedFrame("worker-1"));
    feed.emit(nestedFrame("worker-1"));
    feed.emit(nestedFrame("worker-1"));
    await settle();
    expect(feed.requests).toEqual([0]);
    await vi.advanceTimersByTimeAsync(299);
    expect(feed.requests).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(feed.requests).toEqual([0, 40]);
    expect(feed.pendingReads).toBe(1);
    tail.stop();
  });

  test("a running worker is read again on the heartbeat even when no frame arrives", async () => {
    const feed = new FakeFeed(agentRef());
    const tail = tailFor(feed);
    await startedWithOneMessage(feed, tail);
    await toHeartbeat();
    expect(feed.requests).toEqual([0, 40]);
    tail.stop();
  });

  test("a lifecycle frame reads at once, without waiting for the throttle", async () => {
    const feed = new FakeFeed(agentRef());
    const tail = tailFor(feed);
    await startedWithOneMessage(feed, tail);
    feed.emit(lifecycleEvent("started"));
    await settle();
    expect(feed.requests).toEqual([0, 40]);
    tail.stop();
  });

  test("a worker that finishes gets one last read, and then its timer and live subscription stop", async () => {
    const feed = new FakeFeed(agentRef());
    const tail = tailFor(feed);
    await startedWithOneMessage(feed, tail);
    expect(feed.subscriptions).toBe(1);

    tail.setFeed({ ...feed, agent: agentRef({ status: "completed" }) });
    await settle();
    expect(feed.unsubscriptions).toBe(1);
    expect(feed.requests).toEqual([0, 40]);
    feed.answer(transcriptPage({ fromByte: 40, nextByte: 40 }));
    await settle();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(feed.requests).toEqual([0, 40]);
    tail.stop();
  });

  test("a finished worker's transcript is read page after page, with no frame or heartbeat to ask again", async () => {
    const feed = new FakeFeed(agentRef({ status: "completed" }));
    const tail = tailFor(feed);
    tail.start();
    await settle();
    feed.answer(transcriptPage({ fromByte: 0, nextByte: 40, messages: [userMessage("one")] }));
    await settle();
    expect(feed.requests).toEqual([0, 40]);
    feed.answer(
      transcriptPage({ fromByte: 40, nextByte: 90, messages: [assistantMessage("two")] }),
    );
    await settle();
    expect(feed.requests).toEqual([0, 40, 90]);
    feed.answer(transcriptPage({ fromByte: 90, nextByte: 90 }));
    await settle();
    expect(tail.getView().messages).toHaveLength(2);
    expect(feed.pendingReads).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(feed.requests).toEqual([0, 40, 90]);
    tail.stop();
  });

  test("a failed read is shown with its failure, and the next read that succeeds clears it", async () => {
    const feed = new FakeFeed(agentRef());
    const tail = tailFor(feed);
    tail.start();
    await settle();
    feed.fail(new AppFailure({ code: "not_found", message: "Unknown subagent", retryable: true }));
    await settle();
    expect(tail.getView().failure?.appError.code).toBe("not_found");
    expect(tail.getView().loading).toBe(false);

    await toHeartbeat();
    feed.answer(oneMessage());
    await settle();
    expect(tail.getView().failure).toBeUndefined();
    expect(tail.getView().messages).toHaveLength(1);
    tail.stop();
  });

  test("a live feed that cannot start is reported, and the transcript still refreshes on the timer", async () => {
    const feed = new FakeFeed(agentRef());
    feed.subscribeError = new AppFailure({
      code: "unavailable",
      message: "Live updates are off",
      retryable: false,
      capability: "omp.subagent-events",
    });
    const tail = tailFor(feed);
    await startedWithOneMessage(feed, tail);
    expect(tail.getView().liveFailure?.appError.code).toBe("unavailable");
    await toHeartbeat();
    expect(feed.requests).toEqual([0, 40]);
    tail.stop();
  });

  test("a live feed that is lost later is reported to the view", async () => {
    const feed = new FakeFeed(agentRef());
    const tail = tailFor(feed);
    await startedWithOneMessage(feed, tail);
    feed.reportLiveFailure(
      new AppFailure({ code: "omp_exited", message: "omp stopped", retryable: true }),
    );
    expect(tail.getView().liveFailure?.appError.code).toBe("omp_exited");
    tail.stop();
  });

  test("a read that finishes after stop() does not change the transcript", async () => {
    const feed = new FakeFeed(agentRef());
    const tail = tailFor(feed);
    tail.start();
    await settle();
    tail.stop();
    feed.answer(oneMessage());
    await settle();
    expect(tail.getView().loading).toBe(true);
    expect(tail.getView().messages).toHaveLength(0);
  });

  test("a different worker replaces the transcript and starts again from byte zero", async () => {
    const feed = new FakeFeed(agentRef());
    const tail = tailFor(feed);
    await startedWithOneMessage(feed, tail);

    tail.setFeed({ ...feed, agent: agentRef({ id: "worker-2", sessionFile: replacedFile }) });
    await settle();
    expect(tail.getView().messages).toHaveLength(0);
    expect(tail.getView().loading).toBe(true);
    expect(feed.requests.at(-1)).toBe(0);

    feed.answer(
      transcriptPage({
        file: replacedFile,
        fromByte: 0,
        nextByte: 25,
        messages: [assistantMessage("other worker")],
      }),
    );
    await settle();
    expect(tail.getView().messages).toHaveLength(1);
    tail.stop();
  });

  test("the view changes only when a page changed what is shown", async () => {
    const feed = new FakeFeed(agentRef());
    const tail = tailFor(feed);
    await startedWithOneMessage(feed, tail);
    const shown = tail.getView();
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    feed.answer(transcriptPage({ fromByte: 40, nextByte: 40 }));
    await settle();
    expect(tail.getView()).toBe(shown);
    tail.stop();
  });
});

describe("a worker's live status in its transcript view", () => {
  test("a live worker's last assistant message is running, and a finished worker's messages stay complete", async () => {
    const liveFeed = new FakeFeed(agentRef({ status: "running" }));
    const live = tailFor(liveFeed);
    live.start();
    await settle();
    liveFeed.answer(
      transcriptPage({
        fromByte: 0,
        nextByte: 80,
        messages: [userMessage("one"), assistantMessage("two")],
      }),
    );
    await settle();
    expect(live.getView().messages.map((message) => message.status)).toEqual([
      undefined,
      { type: "running" },
    ]);

    const doneFeed = new FakeFeed(agentRef({ status: "completed" }));
    const done = tailFor(doneFeed);
    done.start();
    await settle();
    doneFeed.answer(
      transcriptPage({
        fromByte: 0,
        nextByte: 80,
        messages: [userMessage("one"), assistantMessage("two")],
      }),
    );
    await settle();
    expect(done.getView().messages.at(-1)?.status).toMatchObject({ type: "complete" });
  });

  test("withLiveStatus marks only the last assistant message, and changes nothing once the worker is not live", () => {
    const complete = { type: "complete", reason: "unknown" } as const;
    const messages: ThreadMessageLike[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }], status: complete },
      { role: "user", content: [{ type: "text", text: "c" }] },
      { role: "assistant", content: [{ type: "text", text: "d" }], status: complete },
    ];
    expect(withLiveStatus(messages, true).map((message) => message.status)).toEqual([
      undefined,
      complete,
      undefined,
      { type: "running" },
    ]);
    expect(withLiveStatus(messages, false)).toBe(messages);
  });
});
