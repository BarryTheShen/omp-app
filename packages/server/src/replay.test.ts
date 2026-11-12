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

describe("a replay leaves out the pieces of what it carries whole", () => {
  const stream = chatSessionEventStream(ThreadId.parse("thread-pieces"));
  const frame = (seq: number, from?: number) => ({
    type: "event" as const,
    stream,
    seq,
    ...(from === undefined ? {} : { from }),
    payload: { n: seq },
  });

  test("a message's updates go when its end is in the replay, and the frame after them says where they began", () => {
    const hub = new EventReplayHub();
    hub.publish(stream, { n: 1 }, { key: "msg-1", whole: false });
    hub.publish(stream, { n: 2 }, { key: "msg-1", whole: false });
    hub.publish(stream, { n: 3 }, { key: "msg-1", whole: true });
    hub.publish(stream, { n: 4 }, { key: "msg-2", whole: false });
    hub.publish(stream, { n: 5 });

    expect(hub.replay(stream, 0)).toEqual({ frames: [frame(3, 1), frame(4), frame(5)] });
    // From the middle of the message: the updates after the cursor go.
    expect(hub.replay(stream, 1)).toEqual({ frames: [frame(3, 2), frame(4), frame(5)] });
  });

  test("live frames, and a message still streaming in a replay, keep every update", () => {
    const hub = new EventReplayHub();
    const live: unknown[] = [];
    hub.subscribe(stream, (sent) => live.push(sent));
    hub.publish(stream, { n: 1 }, { key: "msg-1", whole: false });
    hub.publish(stream, { n: 2 }, { key: "msg-1", whole: true });
    hub.publish(stream, { n: 3 }, { key: "msg-2", whole: false });

    expect(live).toEqual([frame(1), frame(2), frame(3)]);
    expect(hub.replay(stream, 2)).toEqual({ frames: [frame(3)] });
  });
});
