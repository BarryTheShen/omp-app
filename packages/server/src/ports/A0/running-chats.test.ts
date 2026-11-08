import { describe, expect, test } from "bun:test";
import {
  RUNNING_STOP_OTHER_VIEW,
  RunningChatsPort,
  SessionFilePath,
  streamKey,
  ThreadId,
} from "@omp-app/contracts";
import type { PortHandlerContext } from "../../registry/ports";
import { createRunningChatsRuntime, type HeldChat, runningChatTitle } from "./running-chats";

const id = (value: string) => ThreadId.parse(value);

/** What a stop sees of its chat: each tab's views, whether its turn runs, after how many looks an abort ends it. */
interface StopWorld {
  readonly views: Map<string, number>;
  busy: boolean | undefined;
  /** null: the turn never ends. */
  readonly endsAfterLooks: number | null;
  looks: number;
  readonly did: string[];
}

const world = (
  views: Record<string, number>,
  busy: boolean | undefined,
  endsAfterLooks: number | null = 0,
): StopWorld => ({
  views: new Map(Object.entries(views)),
  busy,
  endsAfterLooks,
  looks: 0,
  did: [],
});

/** A runtime over a held list the test sets, whose change sources the test fires. */
function runtimeOver(
  held: HeldChat[],
  waiting: Set<string>,
  titles: Map<string, string | null>,
  stops: StopWorld = world({}, undefined),
) {
  const published: unknown[] = [];
  const listeners = new Set<() => void>();
  const runtime = createRunningChatsRuntime({
    held: () => held,
    waitingFor: (threadId) => waiting.has(threadId),
    titleOf: async (threadId) => {
      if (!titles.has(threadId)) throw new Error("unreadable file");
      return titles.get(threadId) ?? null;
    },
    // The chat that has no file yet has no known file either.
    sessionFileOf: (threadId) =>
      titles.has(threadId) ? SessionFilePath.parse(`/sessions/${threadId}.jsonl`) : undefined,
    changes: [
      (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    ],
    publish: (stream, payload) => {
      expect(stream).toBe(streamKey(RunningChatsPort.name, "changed"));
      published.push(payload);
    },
    views: {
      viewsOf: (_threadId, connectionId) => stops.views.get(connectionId) ?? 0,
      watcherCount: () => [...stops.views.values()].reduce((sum, count) => sum + count, 0),
    },
    busyOf: () => stops.busy,
    abortTurn: async () => {
      stops.did.push("abort");
    },
    stopChat: async (_threadId, ownViews) => {
      stops.did.push(`stop, ${ownViews} own`);
    },
    now: () => 42,
    sleep: async () => {
      stops.looks += 1;
      if (stops.endsAfterLooks !== null && stops.looks >= stops.endsAfterLooks) stops.busy = false;
    },
  });
  const handlers = runtime.registration.handlers as {
    list: () => Promise<{ chats: unknown[] }>;
    stop: (args: unknown, call: PortHandlerContext) => Promise<null>;
  };
  const stop = (threadId: string, tab: string) =>
    handlers.stop({ threadId: id(threadId) }, {
      connectionId: tab,
      signal: new AbortController().signal,
    } as unknown as PortHandlerContext);
  return {
    runtime,
    published,
    change: () => listeners.forEach((listener) => listener()),
    list: () => handlers.list(),
    stop,
  };
}

describe("stopping a running chat (D1)", () => {
  test("an idle chat stops, the asking tab's own views counted as its own", async () => {
    const stops = world({ "tab-a": 2 }, false);
    await runtimeOver([], new Set(), new Map(), stops).stop("chat", "tab-a");
    expect(stops.did).toEqual(["stop, 2 own"]);
  });

  test("another tab or window that has it open refuses the stop, and nothing is stopped", async () => {
    const stops = world({ "tab-a": 1, "tab-b": 1 }, true);
    const stopping = runtimeOver([], new Set(), new Map(), stops).stop("chat", "tab-a");
    await expect(stopping).rejects.toThrow(RUNNING_STOP_OTHER_VIEW);
    expect(stops.did).toEqual([]);
  });

  test("a turn that runs is asked to end first, as Esc ends it, and the stop waits for it to end", async () => {
    const stops = world({}, true, 3);
    await runtimeOver([], new Set(), new Map(), stops).stop("chat", "tab-a");
    expect(stops.did).toEqual(["abort", "stop, 0 own"]);
    expect(stops.looks).toBe(3);
  });

  test("a turn that does not end on the abort ends with the process after ten seconds", async () => {
    const stops = world({}, true, null);
    await runtimeOver([], new Set(), new Map(), stops).stop("chat", "tab-a");
    expect(stops.did).toEqual(["abort", "stop, 0 own"]);
    // Ten seconds, a look every tenth of one.
    expect(stops.looks).toBe(100);
  });

  test("a paused turn waits at omp's gate: it ends with the process at once, with no abort", async () => {
    const stops = world({}, true, null);
    const paused: HeldChat = { threadId: id("chat"), folder: "/w/a", busy: true, pausedAt: 7 };
    await runtimeOver([paused], new Set(), new Map(), stops).stop("chat", "tab-a");
    expect(stops.did).toEqual(["stop, 0 own"]);
    expect(stops.looks).toBe(0);
  });
});

describe("the chats that run, from every folder (D1)", () => {
  test("each chat with its folder, name and state; waiting first, then working, paused, idle, each by name", async () => {
    const held: HeldChat[] = [
      { threadId: id("idle-b"), folder: "/w/a", busy: false, pausedAt: null },
      { threadId: id("paused"), folder: "/w/b", busy: true, pausedAt: 1 },
      { threadId: id("working"), folder: "/w/a", busy: true, pausedAt: null },
      // A question outranks a pause and a turn: it waits for you.
      { threadId: id("waiting"), folder: "/w/c", busy: true, pausedAt: 2 },
      { threadId: id("idle-a"), folder: "/w/b", busy: false, pausedAt: null },
      { threadId: id("unwritten"), folder: "/w/a", busy: false, pausedAt: null },
    ];
    const titles = new Map<string, string | null>([
      ["idle-b", "Beta"],
      ["paused", "Paused one"],
      ["working", "Working one"],
      ["waiting", "Waiting one"],
      ["idle-a", "Alpha"],
    ]);
    const { list } = runtimeOver(held, new Set(["waiting"]), titles);
    expect(await list()).toEqual({
      chats: [
        {
          threadId: "waiting",
          folder: "/w/c",
          title: "Waiting one",
          sessionFile: "/sessions/waiting.jsonl",
          state: "waiting",
        },
        {
          threadId: "working",
          folder: "/w/a",
          title: "Working one",
          sessionFile: "/sessions/working.jsonl",
          state: "working",
        },
        {
          threadId: "paused",
          folder: "/w/b",
          title: "Paused one",
          sessionFile: "/sessions/paused.jsonl",
          state: "paused",
        },
        // No file to name it yet (or none readable): no name, before the named ones.
        { threadId: "unwritten", folder: "/w/a", title: null, sessionFile: null, state: "idle" },
        {
          threadId: "idle-a",
          folder: "/w/b",
          title: "Alpha",
          sessionFile: "/sessions/idle-a.jsonl",
          state: "idle",
        },
        {
          threadId: "idle-b",
          folder: "/w/a",
          title: "Beta",
          sessionFile: "/sessions/idle-b.jsonl",
          state: "idle",
        },
      ],
    });
  });

  test("changes close together go out as one event; after stop, none", async () => {
    const { runtime, published, change } = runtimeOver([], new Set(), new Map());
    change();
    change();
    change();
    await Bun.sleep(150);
    expect(published).toEqual([{ at: 42 }]);
    change();
    runtime.stop();
    await Bun.sleep(150);
    change();
    await Bun.sleep(150);
    expect(published).toEqual([{ at: 42 }]);
  });
});

describe("a running chat's name", () => {
  const file = SessionFilePath.parse("/sessions/-work/2026-11-07T10-00-00-000Z_abc.jsonl");
  const sources = (known: Record<string, typeof file>) => {
    const asked: string[] = [];
    return {
      asked,
      sources: {
        sessionFileOf: (threadId: ThreadId) => known[threadId],
        readFile: async (sessionFile: typeof file) => {
          asked.push(`read ${sessionFile}`);
          return { title: "From the file", firstPrompt: "first" };
        },
        findById: async (threadId: ThreadId) => {
          asked.push(`find ${threadId}`);
          return { title: null, firstPrompt: "found by id" };
        },
        display: (title: string) => `«${title}»`,
      },
    };
  };

  test("comes from the file the chat runs when the app knows it, with no search by id", async () => {
    const { asked, sources: from } = sources({ abc: file });
    expect(await runningChatTitle(id("abc"), from)).toBe("«From the file»");
    expect(asked).toEqual([`read ${file}`]);
  });

  test("is none for a new chat kept ready, which has no file: nothing is read", async () => {
    const { asked, sources: from } = sources({});
    expect(await runningChatTitle(id("provisional-0b6e"), from)).toBeNull();
    expect(asked).toEqual([]);
  });

  test("is found by the chat's id when its file is not known, its first prompt standing in for a title", async () => {
    const { asked, sources: from } = sources({});
    expect(await runningChatTitle(id("def"), from)).toBe("found by id");
    expect(asked).toEqual(["find def"]);
  });
});
