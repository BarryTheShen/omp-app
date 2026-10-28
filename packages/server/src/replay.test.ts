import { describe, expect, test } from "bun:test";
import { chatSessionEventStream, ThreadId } from "@omp-app/contracts";
import { EventReplayHub } from "./replay";

describe("EventReplayHub.moveStream", () => {
  test("carries the history and the sequence to the new key, and leaves the old key empty", () => {
    const hub = new EventReplayHub();
    const before = chatSessionEventStream(ThreadId.parse("thread-before"));
    const after = chatSessionEventStream(ThreadId.parse("thread-after"));
    hub.publish(before, { n: 1 });
    hub.publish(before, { n: 2 });

    hub.moveStream(before, after);

    expect(hub.latestSeq(before)).toBe(0);
    expect(hub.latestSeq(after)).toBe(2);
    expect(hub.replay(after, 0)).toEqual({
      frames: [
        { type: "event", stream: after, seq: 1, payload: { n: 1 } },
        { type: "event", stream: after, seq: 2, payload: { n: 2 } },
      ],
    });
    expect(hub.publish(after, { n: 3 }).seq).toBe(3);
  });

  test("moving a key that has no history changes nothing", () => {
    const hub = new EventReplayHub();
    const empty = chatSessionEventStream(ThreadId.parse("thread-empty"));
    const next = chatSessionEventStream(ThreadId.parse("thread-next"));

    hub.moveStream(empty, next);

    expect(hub.latestSeq(next)).toBe(0);
    expect(hub.publish(next, { n: 1 }).seq).toBe(1);
  });
});
