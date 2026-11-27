import { afterEach, describe, expect, test } from "bun:test";
import { FolderPath, QuestionsPort, streamKey, ThreadId } from "@omp-app/contracts";
import type { OmpQuestionRequest } from "@omp-app/contracts/chat-host";
import type { WaitingAsks } from "./chat-session";
import { createQuestionsRuntime } from "./questions";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const A = ThreadId.parse("thread-a");
const B = ThreadId.parse("thread-b");
const WORK = FolderPath.parse("/work/app");

const confirm = (id: string): OmpQuestionRequest => ({
  id,
  method: "ui.confirm",
  params: { title: "Deploy?", message: "Deploy the build now?" },
});
const pick = (id: string): OmpQuestionRequest => ({
  id,
  method: "ui.select",
  params: { title: "Which branch?", options: ["main", "next"] },
});

/** The runtime over omp's questions as given; what it published, and its list. */
function runtime(asks: () => readonly WaitingAsks[]): {
  readonly published: unknown[];
  readonly waitingChanged: () => void;
  readonly list: () => Promise<unknown>;
} {
  const published: unknown[] = [];
  const listeners = new Set<() => void>();
  const made = createQuestionsRuntime({
    waiting: {
      asks,
      onWaitingChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    titleOf: async (threadId) => (threadId === A ? "Chat A" : null),
    publish: (stream, payload) => published.push([stream, payload]),
    now: () => 7,
  });
  stops.push(made.stop);
  const handlers = made.registration.handlers as { list: () => Promise<unknown> };
  return {
    published,
    waitingChanged: () => {
      for (const listener of listeners) listener();
    },
    list: () => handlers.list(),
  };
}

describe("omp's questions that stop a chat", () => {
  test("are listed by chat, the chat asked most recently first, with its name", async () => {
    let asks: readonly WaitingAsks[] = [
      { threadId: A, folder: WORK, requests: [pick("r-a")], at: 50 },
      { threadId: B, folder: WORK, requests: [confirm("r-b")], at: 300 },
    ];
    const { list } = runtime(() => asks);
    expect(await list()).toEqual({
      chats: [
        { threadId: B, folder: WORK, title: null, requests: [confirm("r-b")] },
        { threadId: A, folder: WORK, title: "Chat A", requests: [pick("r-a")] },
      ],
    });
    // A's answered: only B's is left.
    asks = [{ threadId: B, folder: WORK, requests: [confirm("r-b")], at: 300 }];
    expect(await list()).toEqual({
      chats: [{ threadId: B, folder: WORK, title: null, requests: [confirm("r-b")] }],
    });
  });

  test("a change goes out as one changed to every device", async () => {
    const { published, waitingChanged } = runtime(() => []);
    waitingChanged();
    waitingChanged();
    await Bun.sleep(250);
    expect(published).toEqual([[streamKey(QuestionsPort.name, "changed"), { at: 7 }]]);
  });
});
