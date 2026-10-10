import { describe, expect, test } from "bun:test";
import { ThreadId } from "@omp-app/contracts";
import type { A1PortContext } from "./context";
import { createSessionFileStoreRegistration } from "./session-file-store";

/** Lets the lookup behind a turn change finish its promise chain. Microtasks only: no timers. */
async function settle(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

type BusyListener = (threadId: ThreadId, busy: boolean) => void;

describe("the session file port publishes a chat's turn flips as changed", () => {
  test("each flip publishes the chat's file, found from its id", async () => {
    const threadId = ThreadId.parse("chat-turn");
    const hooks: { notify?: BusyListener } = {};
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
          hooks.notify = listener;
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

    hooks.notify?.(threadId, true);
    await settle();
    hooks.notify?.(threadId, false);
    await settle();

    const file = {
      folder: "/workspace/app",
      sessionFile: "/workspace/app/.omp/chat-turn.jsonl",
      id: threadId,
      kind: "updated",
    };
    expect(published).toEqual([file, file]);
  });

  test("a chat whose file cannot be read publishes nothing, and the flip does not fail", async () => {
    const hooks: { notify?: BusyListener } = {};
    const published: unknown[] = [];
    const context = {
      sessionFileStore: {
        findSession: async (): Promise<undefined> => {
          throw new Error("the file is gone");
        },
      },
      processBusy: {
        onBusyChange: (listener: BusyListener) => {
          hooks.notify = listener;
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

    hooks.notify?.(ThreadId.parse("chat-gone"), true);
    await settle();

    expect(published).toEqual([]);
  });
});
