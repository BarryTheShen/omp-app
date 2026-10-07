import { describe, expect, test } from "vitest";
import { finishedAnswerAt } from "./turn-end";

type Snapshot = NonNullable<Parameters<typeof finishedAnswerAt>[0]>;

/** A snapshot whose messages are the given ones, oldest first. */
function snapshotOf(
  ...messages: readonly { role: string; status?: string; stopReason?: string; timestamp?: number }[]
): Snapshot {
  const entries = messages.map((message, index) => ({
    key: `m${index}`,
    status: message.status ?? "persisted",
    message: {
      role: message.role,
      stopReason: message.stopReason,
      timestamp: message.timestamp ?? index,
    },
  }));
  return {
    messageOrder: entries.map((entry) => entry.key),
    messages: Object.fromEntries(entries.map((entry) => [entry.key, entry])),
  } as unknown as Snapshot;
}

describe("finishedAnswerAt", () => {
  test("is the time of a finished assistant answer that is the newest message", () => {
    expect(
      finishedAnswerAt(
        snapshotOf({ role: "user" }, { role: "assistant", stopReason: "stop", timestamp: 500 }),
      ),
    ).toBe(500);
    // An answer that ended in an error or an interruption is finished too: omp wrote the chat.
    for (const stopReason of ["error", "aborted", "length"]) {
      expect(finishedAnswerAt(snapshotOf({ role: "assistant", stopReason, timestamp: 7 }))).toBe(7);
    }
  });

  test("is undefined while the answer is still streaming or stops for a tool", () => {
    expect(
      finishedAnswerAt(snapshotOf({ role: "assistant", status: "streaming", timestamp: 9 })),
    ).toBeUndefined();
    expect(
      finishedAnswerAt(snapshotOf({ role: "assistant", stopReason: "toolUse", timestamp: 9 })),
    ).toBeUndefined();
  });

  test("is undefined when the newest message is not an answer, and for no messages at all", () => {
    expect(
      finishedAnswerAt(snapshotOf({ role: "assistant", stopReason: "stop" }, { role: "user" })),
    ).toBeUndefined();
    expect(
      finishedAnswerAt(
        snapshotOf({ role: "assistant", stopReason: "stop" }, { role: "toolResult" }),
      ),
    ).toBeUndefined();
    expect(finishedAnswerAt(snapshotOf())).toBeUndefined();
    expect(finishedAnswerAt(undefined)).toBeUndefined();
  });
});
