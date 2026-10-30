import type { ChatSessionEvent } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { AttentionTracker } from "./attention";

function event(value: Record<string, unknown>): ChatSessionEvent {
  return { kind: "event", event: value } as unknown as ChatSessionEvent;
}

function processStatus(status: string, message?: string): ChatSessionEvent {
  return {
    kind: "process",
    status,
    ...(message === undefined ? {} : { error: { code: "internal", message } }),
  } as unknown as ChatSessionEvent;
}

const reply = (stopReason: string, errorMessage?: string) => ({
  role: "assistant",
  content: [],
  stopReason,
  ...(errorMessage === undefined ? {} : { errorMessage }),
});

const end = (messages: readonly unknown[], isTerminal?: boolean) =>
  event({ type: "agent_end", messages, ...(isTerminal === undefined ? {} : { isTerminal }) });

describe("what a chat's run settles with", () => {
  test("a final end is done when the last reply ended normally, and an error with omp's reason when it failed", () => {
    const tracker = new AttentionTracker();
    expect(tracker.take(end([{ role: "user", content: "hi" }, reply("stop")]))).toEqual({
      kind: "done",
    });
    expect(tracker.take(end([reply("toolUse"), reply("error", "Invalid API key")]))).toEqual({
      kind: "error",
      reason: "Invalid API key",
    });
  });

  test("an aborted turn, or one without a reply, settles with nothing to look at", () => {
    const tracker = new AttentionTracker();
    expect(tracker.take(end([reply("aborted")]))).toBeNull();
    expect(tracker.take(end([{ role: "user", content: "hi" }]))).toBeNull();
    // An abort after an earlier reply: omp reads the last one.
    expect(tracker.take(end([reply("stop"), reply("aborted")]))).toBeNull();
  });

  test("while omp retries, an end says nothing; the end after the retry is judged", () => {
    const tracker = new AttentionTracker();
    tracker.take(event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 }));
    expect(tracker.take(end([reply("error", "overloaded")]))).toBeNull();
    tracker.take(event({ type: "auto_retry_end", success: true, attempt: 1 }));
    expect(tracker.take(end([reply("stop")]))).toEqual({ kind: "done" });
  });

  test("an end with more to come is said when the session settles, and not when another run starts first", () => {
    const tracker = new AttentionTracker();
    expect(tracker.take(end([reply("stop")], false))).toBeNull();
    expect(tracker.take(event({ type: "session_settled" }))).toEqual({ kind: "done" });
    expect(tracker.take(event({ type: "session_settled" }))).toBeNull();

    expect(tracker.take(end([reply("stop")], false))).toBeNull();
    tracker.take(event({ type: "agent_start" }));
    expect(tracker.take(event({ type: "session_settled" }))).toBeNull();
    // The run that started is judged by its own end.
    expect(tracker.take(end([reply("error", "boom")]))).toEqual({ kind: "error", reason: "boom" });
    // A final end has been said already: the settle after it says nothing more.
    expect(tracker.take(event({ type: "session_settled" }))).toBeNull();
  });

  test("omp that quits on its own or cannot start is said with its reason; one the server stops is not", () => {
    const tracker = new AttentionTracker();
    expect(tracker.take(processStatus("exited", "omp exited with code 1"))).toEqual({
      kind: "crashed",
      reason: "omp exited with code 1",
    });
    expect(tracker.take(processStatus("error", "omp was not found"))).toEqual({
      kind: "unstarted",
      reason: "omp was not found",
    });
    expect(tracker.take(processStatus("stopped"))).toBeNull();
    expect(tracker.take(processStatus("running"))).toBeNull();
  });
});
