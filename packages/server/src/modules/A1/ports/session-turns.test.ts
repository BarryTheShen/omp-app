import { describe, expect, test } from "bun:test";
import { ThreadId } from "@omp-app/contracts";
import type { A1PortContext } from "./context";
import { createSessionFileStoreRegistration } from "./session-file-store";

/** Lets the lookup behind a turn change finish its promise chain. Microtasks only: no timers. */
async function settle(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

type BusyListener = (threadId: ThreadId, busy: boolean) => void;

describe("the session file port publishes turn and running-list changes", () => {
  test("each flip publishes the file change and the folder running change", async () => {
    const threadId = ThreadId.parse("chat-turn");
    const hooks: BusyListener[] = [];
    const published: unknown[] = [];
    const context = {
      sessionFileStore: {
        findSession: async (sessionId: string) =>
          sessionId === threadId
            ? { cwd: "/workspace/app", sessionFile: "/workspace/app/.omp/chat-turn.jsonl" }
            : undefined,
        onBackground: () => () => undefined,
      },
      processBusy: {
        onBusyChange: (listener: BusyListener) => {
          hooks.push(listener);
          return () => undefined;
        },
        folderOf: () => "/workspace/app",
      },
      publish: (_stream: unknown, payload: unknown) => {
        published.push(payload);
        return undefined;
      },
      watchStreamActivity: () => () => undefined,
    } as unknown as A1PortContext;
    createSessionFileStoreRegistration(context);

    for (const listener of hooks) listener(threadId, true);
    await settle();
    for (const listener of hooks) listener(threadId, false);
    await settle();

    expect(published).toEqual([
      { folder: "/workspace/app", id: threadId, busy: true },
      {
        folder: "/workspace/app",
        sessionFile: "/workspace/app/.omp/chat-turn.jsonl",
        id: threadId,
        kind: "updated",
      },
      { folder: "/workspace/app", id: threadId, busy: false },
      {
        folder: "/workspace/app",
        sessionFile: "/workspace/app/.omp/chat-turn.jsonl",
        id: threadId,
        kind: "updated",
      },
    ]);
  });

  test("a file-less chat still publishes its folder running change", async () => {
    const threadId = ThreadId.parse("chat-gone");
    const hooks: BusyListener[] = [];
    const published: unknown[] = [];
    const context = {
      sessionFileStore: {
        findSession: async (): Promise<undefined> => {
          throw new Error("the file is gone");
        },
        onBackground: () => () => undefined,
      },
      processBusy: {
        onBusyChange: (listener: BusyListener) => {
          hooks.push(listener);
          return () => undefined;
        },
        folderOf: () => "/workspace/app",
      },
      publish: (_stream: unknown, payload: unknown) => {
        published.push(payload);
        return undefined;
      },
      watchStreamActivity: () => () => undefined,
    } as unknown as A1PortContext;
    createSessionFileStoreRegistration(context);

    for (const listener of hooks) listener(threadId, true);
    await settle();

    expect(published).toEqual([{ folder: "/workspace/app", id: threadId, busy: true }]);
  });
  test("an invalid folder event is dropped without throwing through the process registry", () => {
    const threadId = ThreadId.parse("chat-invalid-folder");
    const hooks: BusyListener[] = [];
    const published: unknown[] = [];
    const context = {
      sessionFileStore: {
        findSession: async (): Promise<undefined> => undefined,
        onBackground: () => () => undefined,
      },
      processBusy: {
        onBusyChange: (listener: BusyListener) => {
          hooks.push(listener);
          return () => undefined;
        },
        folderOf: () => "relative-folder",
      },
      publish: (_stream: unknown, payload: unknown) => {
        published.push(payload);
        return undefined;
      },
      watchStreamActivity: () => () => undefined,
    } as unknown as A1PortContext;
    createSessionFileStoreRegistration(context);

    expect(() => hooks[0]?.(threadId, true)).not.toThrow();
    expect(published).toEqual([]);
  });
});

type PauseListener = (threadId: ThreadId, folder: string, pausedAt: number | null) => void;

describe("the session file port publishes pauses and lists the paused chats", () => {
  test("each pause change publishes with the chat's folder, and the list answers the folder's paused chats", async () => {
    const threadId = ThreadId.parse("chat-paused");
    const hooks: PauseListener[] = [];
    const published: unknown[] = [];
    const context = {
      sessionFileStore: { onBackground: () => () => undefined },
      processPause: {
        onPauseChange: (listener: PauseListener) => {
          hooks.push(listener);
          return () => undefined;
        },
        pausedIn: (folder: string) =>
          folder === "/workspace/app" ? [{ id: threadId, pausedAt: 5_000 }] : [],
      },
      publish: (_stream: unknown, payload: unknown) => {
        published.push(payload);
        return undefined;
      },
      watchStreamActivity: () => () => undefined,
    } as unknown as A1PortContext;
    const registration = createSessionFileStoreRegistration(context);

    for (const listener of hooks) listener(threadId, "/workspace/app", 5_000);
    for (const listener of hooks) listener(threadId, "/workspace/app", null);
    expect(published).toEqual([
      { folder: "/workspace/app", id: threadId, pausedAt: 5_000 },
      { folder: "/workspace/app", id: threadId, pausedAt: null },
    ]);

    const list = registration.handlers.listPaused;
    if (list === undefined) throw new Error("the port has no listPaused handler");
    const handlerContext = {
      signal: new AbortController().signal,
      connectionId: "c",
      requestId: "r",
      portContext: undefined,
    } as never;
    expect(await list({ folder: "/workspace/app" }, handlerContext)).toEqual({
      chats: [{ id: threadId, pausedAt: 5_000 }],
    });
    expect(await list({ folder: "/workspace/other" }, handlerContext)).toEqual({ chats: [] });
  });
});

describe("the session file port publishes a chat its omp names (#2798)", () => {
  test("a title change publishes the chat's file as updated, so the list reads its title again", async () => {
    const threadId = ThreadId.parse("chat-named");
    const hooks: ((threadId: ThreadId) => void)[] = [];
    const published: unknown[] = [];
    const context = {
      sessionFileStore: {
        findSession: async (sessionId: string) =>
          sessionId === threadId
            ? { cwd: "/workspace/app", sessionFile: "/workspace/app/.omp/chat-named.jsonl" }
            : undefined,
        onBackground: () => () => undefined,
      },
      processTitles: {
        onTitleChange: (listener: (threadId: ThreadId) => void) => {
          hooks.push(listener);
          return () => undefined;
        },
      },
      publish: (_stream: unknown, payload: unknown) => {
        published.push(payload);
        return undefined;
      },
      watchStreamActivity: () => () => undefined,
    } as unknown as A1PortContext;
    createSessionFileStoreRegistration(context);

    for (const listener of hooks) listener(threadId);
    await settle();

    expect(published).toEqual([
      {
        folder: "/workspace/app",
        sessionFile: "/workspace/app/.omp/chat-named.jsonl",
        id: threadId,
        kind: "updated",
      },
    ]);
  });
});
