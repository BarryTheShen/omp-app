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
      sessionFileStore: { findSession: async (): Promise<undefined> => undefined },
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
