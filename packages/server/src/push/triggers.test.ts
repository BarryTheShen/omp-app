import { expect, test } from "bun:test";
import type { ThreadId } from "@omp-app/contracts";
import type { PushMessage } from "./service";
import { watchForPush } from "./triggers";

/** A server with chats, a clock the test moves, and the pushes sent. */
function world() {
  const sent: PushMessage[] = [];
  const waiting = new Set<string>();
  const watchers = new Map<string, number>();
  let waitingListener: () => void = () => {};
  let turnListener: (id: ThreadId) => void = () => {};
  let completion = true;
  const timers: { run: () => void; at: number }[] = [];
  let now = 0;
  const stop = watchForPush({
    send: async (message) => {
      sent.push(message);
    },
    running: () => [{ threadId: "t-1" as ThreadId }, { threadId: "t-2" as ThreadId }],
    waitingFor: (id) => waiting.has(id),
    onWaitingChange: (listener) => {
      waitingListener = listener;
      return () => {};
    },
    onTurnEnd: (listener) => {
      turnListener = listener;
      return () => {};
    },
    watchers: (id) => watchers.get(id) ?? 0,
    titleOf: async (id) => (id === "t-1" ? "Fix the build" : null),
    completionOn: async () => completion,
    graceMs: 8_000,
    timers: {
      set: (run, ms) => {
        const timer = { run, at: now + ms };
        timers.push(timer);
        return timer;
      },
      clear: (handle) =>
        timers.splice(timers.indexOf(handle as { run: () => void; at: number }), 1),
    },
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers.filter((each) => each.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
    await Bun.sleep(5);
  };
  return {
    sent,
    stop,
    advance,
    ask: (id: string) => {
      waiting.add(id);
      waitingListener();
    },
    answer: (id: string) => {
      waiting.delete(id);
      waitingListener();
    },
    endTurn: async (id: string) => {
      turnListener(id as ThreadId);
      await Bun.sleep(5);
    },
    watch: (id: string, count: number) => watchers.set(id, count),
    completionOff: () => {
      completion = false;
    },
  };
}

test("a chat that starts waiting while no page shows it is pushed after the grace, once, opening that chat", async () => {
  const w = world();
  w.ask("t-1");
  w.ask("t-1");
  await w.advance(7_999);
  expect(w.sent).toEqual([]);
  await w.advance(1);
  expect(w.sent).toEqual([
    { title: "Fix the build", body: "Waiting for you", chat: "t-1", tag: "chat-t-1" },
  ]);
});

test("nothing is pushed for a chat a page shows, or one answered within the grace", async () => {
  const w = world();
  w.watch("t-1", 1);
  w.ask("t-1");
  w.ask("t-2");
  w.answer("t-2");
  await w.advance(10_000);
  expect(w.sent).toEqual([]);
});

test("a turn's end is pushed as omp's Complete unless completion.notify is off; untitled chats say A chat", async () => {
  const w = world();
  await w.endTurn("t-2");
  await w.advance(8_000);
  expect(w.sent).toEqual([{ title: "A chat", body: "Complete", chat: "t-2", tag: "chat-t-2" }]);
  w.completionOff();
  await w.endTurn("t-1");
  await w.advance(8_000);
  expect(w.sent).toHaveLength(1);
});
