import type {
  OpenThreadArgs,
  OpenThreadResult,
  SessionRenameArgs,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SessionCatalogFilter, SessionMetadata } from "../contract";
import { createNativeRemoteThreadListAdapter, type RemoteThreadCatalogSource } from ".";

const folder = "/workspace/project" as SessionMetadata["cwd"];
const scope = { kind: "folder" as const, folder };
const threadOne = ThreadIdSchema.parse("thread-one");
const threadTwo = ThreadIdSchema.parse("thread-two");

function metadata(id: ThreadId, title: string, updatedAt: string): SessionMetadata {
  return {
    id,
    sessionFile: `/workspace/project/.omp/${id}.jsonl` as SessionMetadata["sessionFile"],
    version: 3,
    title,
    displayTitle: title,
    firstPrompt: null,
    cwd: folder,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt,
    parentSession: null,
    messageCount: 2,
    assistantTurns: 1,
    sizeBytes: 100,
    status: "complete",
    liveness: { lease: "free", serverProcess: false },
    subagents: [],
    parseWarnings: [],
    scope,
    provenance: "native",
    pinned: false,
  };
}

function catalogSource(sessions: readonly SessionMetadata[]): RemoteThreadCatalogSource {
  const filter: SessionCatalogFilter = { scope, query: "" };
  return {
    getSnapshot: () => ({ filter }),
    list: async () => ({ sessions, nextCursor: null }),
    fetch: async (threadId) => {
      const result = sessions.find((session) => session.id === threadId);
      if (!result)
        throw new AppFailure({ code: "not_found", message: "missing", retryable: false });
      return result;
    },
    refresh: async () => undefined,
  };
}

function openResult(threadId: ThreadId): OpenThreadResult {
  return {
    threadId,
    sessionFile: `/workspace/project/.omp/${threadId}.jsonl` as SessionMetadata["sessionFile"],
    capabilities: {},
  };
}

describe("NativeRemoteThreadListAdapter", () => {
  test("maps catalog metadata to assistant-ui list metadata and forwards cursors", async () => {
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([
        metadata(threadOne, "One", "2026-10-05T00:00:00.000Z"),
        metadata(threadTwo, "Two", "2026-10-04T00:00:00.000Z"),
      ]),
      open: async (args: OpenThreadArgs) =>
        openResult("threadId" in args ? args.threadId : threadOne),
    });
    const page = await adapter.list({ after: "cursor-2" });
    expect(page.threads).toMatchObject([
      { remoteId: threadOne, title: "One", status: "regular" },
      { remoteId: threadTwo, title: "Two", status: "regular" },
    ]);
    expect(page.threads[0]?.lastMessageAt).toBeInstanceOf(Date);
  });

  test("rename sends the typed rename port, then re-reads the chat so the list shows the saved title", async () => {
    const order: string[] = [];
    const renames: SessionRenameArgs[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: {
        ...catalogSource([]),
        refresh: async (threadId) => {
          order.push(`refresh ${threadId}`);
        },
      },
      open: async () => openResult(threadOne),
      rename: async (args) => {
        order.push("rename");
        renames.push(args);
        return null;
      },
    });
    await adapter.rename(threadOne, "Renamed");
    expect(renames).toEqual([{ threadId: threadOne, name: "Renamed" }]);
    expect(order).toEqual(["rename", `refresh ${threadOne}`]);
  });

  test("a pick of the chat already loaded sends nothing while the newest open has finished (issue 1359)", async () => {
    const opened: OpenThreadArgs[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([metadata(threadOne, "One", "2026-10-05T00:00:00.000Z")]),
      open: async (args: OpenThreadArgs) => {
        opened.push(args);
        return openResult(threadOne);
      },
      loadedThreadId: () => threadOne,
    });
    await expect(adapter.initialize(threadOne)).resolves.toMatchObject({ remoteId: threadOne });
    expect(opened).toEqual([]);
  });

  test("a pick of the chat already loaded is an open while a New chat is still opening, so the pick is the newest", async () => {
    const opened: OpenThreadArgs[] = [];
    const newChat = Promise.withResolvers<OpenThreadResult>();
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([metadata(threadOne, "One", "2026-10-05T00:00:00.000Z")]),
      open: (args: OpenThreadArgs) => {
        opened.push(args);
        if ("start" in args) return newChat.promise;
        return Promise.resolve(openResult(threadOne));
      },
      loadedThreadId: () => threadOne,
    });
    const creating = adapter.initialize("new");
    await expect(adapter.initialize(threadOne)).resolves.toMatchObject({ remoteId: threadOne });
    expect(opened.at(-1)).toEqual({ threadId: threadOne });
    newChat.resolve(openResult(threadTwo));
    await expect(creating).rejects.toMatchObject({ appError: { code: "cancelled" } });
  });

  test("a pick of another chat opens it while the chat on screen is loaded (issue 1359)", async () => {
    const opened: OpenThreadArgs[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([
        metadata(threadOne, "One", "2026-10-05T00:00:00.000Z"),
        metadata(threadTwo, "Two", "2026-10-04T00:00:00.000Z"),
      ]),
      open: async (args: OpenThreadArgs) => {
        opened.push(args);
        return openResult(threadTwo);
      },
      loadedThreadId: () => threadOne,
    });
    await expect(adapter.initialize(threadTwo)).resolves.toMatchObject({ remoteId: threadTwo });
    expect(opened).toEqual([{ threadId: threadTwo }]);
  });

  test("a rename omp refuses keeps omp's reason, and the list is not re-read", async () => {
    const refreshed: ThreadId[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: {
        ...catalogSource([]),
        refresh: async (threadId) => {
          refreshed.push(threadId);
        },
      },
      open: async () => openResult(threadOne),
      rename: async () => {
        throw new AppFailure({
          code: "conflict",
          message: "Another omp is using this chat.",
          retryable: true,
        });
      },
    });
    await expect(adapter.rename(threadOne, "Busy")).rejects.toMatchObject({
      appError: { code: "conflict", message: "Another omp is using this chat." },
    });
    expect(refreshed).toEqual([]);
  });

  test("without the rename port a rename is unavailable, and it names the capability", async () => {
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => openResult(threadOne),
    });
    await expect(adapter.rename(threadOne, "Nope")).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "omp.cmd.set_session_name" },
    });
  });

  test("new-thread initialize completes open before the caller appends", async () => {
    const order: string[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => {
        order.push("start" in args && args.start === "new" ? "open-new" : "open-existing");
        return openResult(threadOne);
      },
      onThreadIdChange: () => order.push("selected"),
    });
    const result = await adapter.initialize("new");
    order.push("append");
    expect(result.remoteId).toBe(threadOne);
    expect(order).toEqual(["open-new", "selected", "append"]);
  });

  test("switching threads keeps selection callbacks ordered and stable", async () => {
    const switched: ThreadId[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => openResult("threadId" in args ? args.threadId : threadTwo),
      onThreadIdChange: (threadId) => {
        if (threadId) switched.push(threadId);
      },
    });
    await adapter.switchToThread(threadOne);
    await adapter.switchToThread(threadTwo);
    expect(switched).toEqual([threadOne, threadTwo]);
    expect(adapter.getCurrentThreadId()).toBe(threadTwo);
  });

  test("lets go of the hold its open takes, so the chat is held once (by the selected-chat controller)", async () => {
    const calls: string[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => {
        calls.push("threadId" in args ? `open ${args.threadId}` : "open new");
        return openResult("threadId" in args ? args.threadId : threadOne);
      },
      close: async ({ threadId }) => {
        calls.push(`close ${threadId}`);
        return null;
      },
    });
    await adapter.initialize("new");
    await adapter.switchToThread(threadTwo);
    expect(calls).toEqual([
      "open new",
      `close ${threadOne}`,
      `open ${threadTwo}`,
      `close ${threadTwo}`,
    ]);
  });

  test("a failed open holds nothing, and a failing release never fails the open", async () => {
    const released: ThreadId[] = [];
    const failing = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => {
        throw new AppFailure({ code: "permission", message: "denied", retryable: false });
      },
      close: async ({ threadId }) => {
        released.push(threadId);
        return null;
      },
    });
    await expect(failing.initialize("new")).rejects.toMatchObject({
      appError: { code: "permission" },
    });
    expect(released).toEqual([]);

    const forgetful = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => openResult(threadOne),
      close: async () => {
        throw new AppFailure({ code: "not_found", message: "gone", retryable: false });
      },
    });
    await expect(forgetful.initialize("new")).resolves.toMatchObject({ remoteId: threadOne });
  });

  test("surfaces typed failures and gates unsupported archive/delete actions", async () => {
    const failure = new AppFailure({ code: "permission", message: "denied", retryable: false });
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => {
        throw failure;
      },
    });
    await expect(adapter.initialize(threadOne)).rejects.toBe(failure);
    await expect(adapter.archive(threadOne)).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    await expect(adapter.delete(threadOne)).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
  });

  test("a new chat that finishes opening after the chat picked after it is let go", async () => {
    const newChatOpen = Promise.withResolvers<OpenThreadResult>();
    const released: ThreadId[] = [];
    const selected: ThreadId[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => ("threadId" in args ? openResult(args.threadId) : newChatOpen.promise),
      close: async ({ threadId }) => {
        released.push(threadId);
        return null;
      },
      onThreadIdChange: (threadId) => {
        if (threadId) selected.push(threadId);
      },
    });
    const newChat = adapter.initialize("new");
    const picked = await adapter.initialize(threadOne);
    newChatOpen.resolve(openResult(threadTwo));

    await expect(newChat).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(picked.remoteId).toBe(threadOne);
    expect(selected).toEqual([threadOne]);
    expect(adapter.getCurrentThreadId()).toBe(threadOne);
    expect(released).toContain(threadTwo);
  });

  test("a pick's open waits for the page: nothing reaches omp until the page has opened the chat", async () => {
    const opened: OpenThreadArgs[] = [];
    const page = Promise.withResolvers<boolean>();
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args: OpenThreadArgs) => {
        opened.push(args);
        return openResult(threadOne);
      },
    });
    const picked = adapter.initialize(threadOne, { after: page.promise });
    expect(opened).toEqual([]);
    page.resolve(true);
    await expect(picked).resolves.toMatchObject({ remoteId: threadOne });
    expect(opened).toEqual([{ threadId: threadOne }]);
  });

  test("a pick the page did not open opens nothing on omp; the chat picked next is selected", async () => {
    const opened: OpenThreadArgs[] = [];
    const selected: ThreadId[] = [];
    const page = Promise.withResolvers<boolean>();
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args: OpenThreadArgs) => {
        opened.push(args);
        return openResult("threadId" in args ? args.threadId : threadTwo);
      },
      onThreadIdChange: (threadId) => {
        if (threadId) selected.push(threadId);
      },
    });
    const refused = adapter.initialize(threadOne, { after: page.promise });
    const next = await adapter.initialize(threadTwo);
    page.resolve(false);
    await expect(refused).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(next.remoteId).toBe(threadTwo);
    expect(opened).toEqual([{ threadId: threadTwo }]);
    expect(selected).toEqual([threadTwo]);
  });

  test("a New chat clicked during a pick's page open keeps its place, even if the pick finishes first", async () => {
    const newChatOpen = Promise.withResolvers<OpenThreadResult>();
    const page = Promise.withResolvers<boolean>();
    const selected: ThreadId[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args: OpenThreadArgs) =>
        "threadId" in args ? openResult(args.threadId) : newChatOpen.promise,
      onThreadIdChange: (threadId) => {
        if (threadId) selected.push(threadId);
      },
    });
    // The pick takes its number at the click, before the New chat does; its open waits for the page's answer.
    const picked = adapter.initialize(threadOne, { after: page.promise });
    const newChat = adapter.initialize("new");
    page.resolve(true);
    await expect(picked).resolves.toMatchObject({ remoteId: threadOne });
    newChatOpen.resolve(openResult(threadTwo));
    await expect(newChat).resolves.toMatchObject({ remoteId: threadTwo });
    expect(selected).toEqual([threadOne, threadTwo]);
    expect(adapter.getCurrentThreadId()).toBe(threadTwo);
  });

  test("a pick of the chat already loaded sends nothing once the page answers, though an open was in flight", async () => {
    const opened: OpenThreadArgs[] = [];
    const earlierOpen = Promise.withResolvers<OpenThreadResult>();
    const page = Promise.withResolvers<boolean>();
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      loadedThreadId: () => threadOne,
      open: async (args: OpenThreadArgs) => {
        opened.push(args);
        return "threadId" in args && args.threadId === threadTwo
          ? earlierOpen.promise
          : openResult(threadOne);
      },
    });
    const earlier = adapter.initialize(threadTwo);
    const picked = adapter.initialize(threadOne, { after: page.promise });
    earlierOpen.resolve(openResult(threadTwo));
    await expect(earlier).resolves.toMatchObject({ remoteId: threadTwo });
    page.resolve(true);
    await expect(picked).resolves.toMatchObject({ remoteId: threadOne });
    expect(opened).toEqual([{ threadId: threadTwo }]);
  });

  test("a chat picked after one that already finished is selected, and both are applied in order", async () => {
    const selected: ThreadId[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => openResult("threadId" in args ? args.threadId : threadTwo),
      onThreadIdChange: (threadId) => {
        if (threadId) selected.push(threadId);
      },
    });
    await adapter.initialize(threadOne);
    await adapter.initialize("new");
    expect(selected).toEqual([threadOne, threadTwo]);
    expect(adapter.getCurrentThreadId()).toBe(threadTwo);
  });

  test("a failed later pick also lets an earlier one go, and a failed pick selects nothing", async () => {
    const newChatOpen = Promise.withResolvers<OpenThreadResult>();
    const failure = new AppFailure({ code: "permission", message: "denied", retryable: false });
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => {
        if (!("threadId" in args)) return newChatOpen.promise;
        throw failure;
      },
    });
    const newChat = adapter.initialize("new");
    await expect(adapter.initialize(threadOne)).rejects.toBe(failure);
    newChatOpen.resolve(openResult(threadTwo));

    await expect(newChat).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(adapter.getCurrentThreadId()).toBeUndefined();
  });

  test("a New chat clicked after a pick opens its own chat, and the earlier New chat still opening is let go", async () => {
    const threadThree = ThreadIdSchema.parse("thread-three");
    const firstNewChat = Promise.withResolvers<OpenThreadResult>();
    const released: ThreadId[] = [];
    const selected: ThreadId[] = [];
    let newChats = 0;
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => {
        if ("threadId" in args) return openResult(args.threadId);
        newChats += 1;
        return newChats === 1 ? firstNewChat.promise : openResult(threadThree);
      },
      close: async ({ threadId }) => {
        released.push(threadId);
        return null;
      },
      onThreadIdChange: (threadId) => {
        if (threadId) selected.push(threadId);
      },
    });
    const firstNew = adapter.initialize("new");
    await adapter.initialize(threadOne);
    const secondNew = adapter.initialize("new");
    firstNewChat.resolve(openResult(threadTwo));

    await expect(firstNew).rejects.toMatchObject({ appError: { code: "cancelled" } });
    await expect(secondNew).resolves.toMatchObject({ remoteId: threadThree });
    expect(selected).toEqual([threadOne, threadThree]);
    expect(adapter.getCurrentThreadId()).toBe(threadThree);
    expect(released).toContain(threadTwo);
  });

  test("a chat picked again after a later pick opens again, and the earlier open of it is let go", async () => {
    const firstOpen = Promise.withResolvers<OpenThreadResult>();
    const selected: ThreadId[] = [];
    let picksOfOne = 0;
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => {
        if ("threadId" in args && args.threadId === threadOne) {
          picksOfOne += 1;
          if (picksOfOne === 1) return firstOpen.promise;
        }
        return openResult("threadId" in args ? args.threadId : threadTwo);
      },
      onThreadIdChange: (threadId) => {
        if (threadId) selected.push(threadId);
      },
    });
    const firstPick = adapter.initialize(threadOne);
    await adapter.initialize(threadTwo);
    const secondPick = adapter.initialize(threadOne);
    firstOpen.resolve(openResult(threadOne));

    await expect(firstPick).rejects.toMatchObject({ appError: { code: "cancelled" } });
    await expect(secondPick).resolves.toMatchObject({ remoteId: threadOne });
    expect(selected).toEqual([threadTwo, threadOne]);
    expect(adapter.getCurrentThreadId()).toBe(threadOne);
  });

  test("a second click on a New chat that is still opening shares its one open", async () => {
    const newChatOpen = Promise.withResolvers<OpenThreadResult>();
    let opened = 0;
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => {
        opened += 1;
        return newChatOpen.promise;
      },
    });
    const first = adapter.initialize("new");
    const second = adapter.initialize("new");
    newChatOpen.resolve(openResult(threadOne));

    await expect(second).resolves.toMatchObject({ remoteId: threadOne });
    await expect(first).resolves.toMatchObject({ remoteId: threadOne });
    expect(opened).toBe(1);
  });

  test("a New chat started for its caller keeps the hold its open takes, until the caller adopts it", async () => {
    const calls: string[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => {
        calls.push("threadId" in args ? `open ${args.threadId}` : "open new");
        return openResult("threadId" in args ? args.threadId : threadOne);
      },
      close: async ({ threadId }) => {
        calls.push(`close ${threadId}`);
        return null;
      },
    });
    const started = await adapter.startNew();
    expect(started.threadId).toBe(threadOne);
    expect(calls).toEqual(["open new"]);
    expect(adapter.adopt(threadOne)).toBe(true);
    expect(adapter.adopt(threadOne)).toBe(false);
    expect(calls).toEqual(["open new"]);
  });

  test("a New chat no caller adopts is let go when the next pick finishes", async () => {
    const calls: string[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => {
        calls.push("threadId" in args ? `open ${args.threadId}` : "open new");
        return openResult("threadId" in args ? args.threadId : threadOne);
      },
      close: async ({ threadId }) => {
        calls.push(`close ${threadId}`);
        return null;
      },
    });
    await adapter.startNew();
    await adapter.switchToThread(threadTwo);
    expect(calls).toEqual([
      "open new",
      `open ${threadTwo}`,
      `close ${threadOne}`,
      `close ${threadTwo}`,
    ]);
    expect(adapter.adopt(threadOne)).toBe(false);
  });

  test("a New chat started after one nobody adopted lets the older one go, and only the newest is adopted", async () => {
    const opened = [threadOne, threadTwo];
    const closed: ThreadId[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => openResult(opened.shift() ?? threadTwo),
      close: async ({ threadId }) => {
        closed.push(threadId);
        return null;
      },
    });
    await adapter.startNew();
    await adapter.startNew();
    expect(closed).toEqual([threadOne]);
    expect(adapter.adopt(threadOne)).toBe(false);
    expect(adapter.adopt(threadTwo)).toBe(true);
    expect(closed).toEqual([threadOne]);
  });

  test("a New chat started for its caller that finishes after a later pick is let go, and is not adopted", async () => {
    const newChatOpen = Promise.withResolvers<OpenThreadResult>();
    const closed: ThreadId[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => ("threadId" in args ? openResult(args.threadId) : newChatOpen.promise),
      close: async ({ threadId }) => {
        closed.push(threadId);
        return null;
      },
    });
    const started = adapter.startNew();
    await adapter.switchToThread(threadTwo);
    newChatOpen.resolve(openResult(threadOne));
    await expect(started).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(closed).toEqual([threadTwo, threadOne]);
    expect(adapter.adopt(threadOne)).toBe(false);
  });

  test("a New chat started for its caller that fails holds nothing and is not adopted", async () => {
    const closed: ThreadId[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => {
        throw new AppFailure({ code: "permission", message: "denied", retryable: false });
      },
      close: async ({ threadId }) => {
        closed.push(threadId);
        return null;
      },
    });
    await expect(adapter.startNew()).rejects.toMatchObject({ appError: { code: "permission" } });
    expect(closed).toEqual([]);
    expect(adapter.adopt(threadOne)).toBe(false);
  });
});
