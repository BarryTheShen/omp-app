import type { AppClient, AppClientSubscription, SubscribeOptions } from "@omp-app/client";
import type {
  FolderPath,
  OpenThreadArgs,
  RpcSessionClient,
  RpcSessionEvent,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, SessionFileStore, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { SessionHistoryLoader } from "@/modules/R0/history/history";
import { createSelectedThreadHistoryController } from ".";

const folder = "/workspace/project" as FolderPath;
const threadOne = ThreadIdSchema.parse("thread-one");
const threadTwo = ThreadIdSchema.parse("thread-two");

function createRpc(
  open: (args: OpenThreadArgs) => unknown,
  calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [],
): RpcSessionClient {
  const send = async (args: {
    threadId: ThreadId;
    command: { type: string };
  }): Promise<unknown> => {
    calls.push({ type: args.command.type, threadId: args.threadId });
    switch (args.command.type) {
      case "get_state":
        return { sessionId: args.threadId };
      case "get_entries":
        return { entries: [], leafId: null };
      default:
        return undefined;
    }
  };
  return {
    open: async (args: OpenThreadArgs) => open(args),
    send: send as RpcSessionClient["send"],
    subscribe: async () => ({ stream: "A0.rpcSession/event/thread" as never }),
    answerExtensionUi: async () => null,
    answerHostTool: async () => null,
    answerHostUri: async () => null,
    setSubagentSubscription: async () => ({ level: "off" }),
    setEventFilter: async () => ({ events: null }),
    restart: async () => null,
    close: async () => null,
  } as unknown as RpcSessionClient;
}

interface SubscriptionRecord {
  readonly options?: SubscribeOptions;
  readonly listeners: Array<(event: RpcSessionEvent, seq: number) => void>;
  unsubscribed: boolean;
}

function fakeClient(rpc: RpcSessionClient, subscriptions: SubscriptionRecord[]): AppClient {
  return {
    connectionState: "open",
    instanceId: "instance-1",
    port: () => rpc,
    onConnectionState: () => () => {},
    onResync: () => () => {},
    subscribe: async (_port: unknown, _event: unknown, options?: SubscribeOptions) => {
      const record: SubscriptionRecord = { options, listeners: [], unsubscribed: false };
      subscriptions.push(record);
      const subscription: AppClientSubscription<RpcSessionEvent> = {
        stream: "A0.rpcSession/event/thread" as never,
        lastSeq: options?.afterSeq ?? 0,
        onEvent: (listener) => {
          record.listeners.push(listener);
          return () => {
            const index = record.listeners.indexOf(listener);
            if (index >= 0) record.listeners.splice(index, 1);
          };
        },
        unsubscribe: async () => {
          record.unsubscribed = true;
        },
      };
      return subscription as never;
    },
    dispose: () => {},
  } as unknown as AppClient;
}

describe("SelectedThreadHistoryController open and paging", () => {
  test("opens existing, loads the newest page, then pages older history through the thread's loader", async () => {
    const calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(
      (_args) => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      calls,
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const older = vi
      .spyOn(SessionHistoryLoader.prototype, "loadOlder")
      .mockResolvedValue(undefined);
    try {
      const store = await controller.openExisting(threadOne);
      expect(controller.getSnapshot().capabilities).toEqual({});
      await controller.loadOlder();

      expect(store.getSnapshot().threadId).toBe(threadOne);
      expect(older).toHaveBeenCalledTimes(1);
      expect(calls.map((call) => call.type)).toEqual(["get_state", "get_entries"]);
      expect(subscriptions).toHaveLength(1);
    } finally {
      older.mockRestore();
    }
  });

  test("reads the newest window from the thread's session file through the file-store port", async () => {
    const sessionFile = "/workspace/project/thread-one.jsonl";
    const base = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const rpc = {
      ...base,
      send: async (args: { command: { type: string } }) =>
        args.command.type === "get_state"
          ? { sessionId: "s1", sessionFile }
          : { entries: [], leafId: null },
    } as unknown as RpcSessionClient;
    const windowArgs: unknown[] = [];
    const sessionFiles = {
      readEntryWindow: async (args: unknown) => {
        windowArgs.push(args);
        return {
          sessionFile,
          leafId: null,
          fileLastId: null,
          entries: [],
          oldestId: null,
          hasOlder: false,
        };
      },
    };
    const client = {
      ...fakeClient(rpc, []),
      port: (schema: unknown) => (schema === SessionFileStore ? sessionFiles : rpc),
    } as unknown as AppClient;
    const controller = createSelectedThreadHistoryController({ client, folder });

    await controller.openExisting(threadOne);

    expect(windowArgs).toEqual([{ sessionFile }]);
  });

  test("opens new and latest sessions with explicit folder start intents", async () => {
    const opens: unknown[] = [];
    const rpc = createRpc((args) => {
      opens.push(args);
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });
    await controller.openNew();
    await controller.openLatest();
    expect(opens).toEqual([
      { folderPath: folder, start: "new" },
      { folderPath: folder, start: "latest" },
    ]);
  });

  test("switching threads unsubscribes the old event stream before opening the new one", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc((args) => ({
      threadId:
        args && (args as { threadId?: ThreadId }).threadId === threadOne ? threadOne : threadTwo,
      sessionFile: null,
      capabilities: {},
    }));
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    await controller.openExisting(threadOne);
    await controller.openExisting(threadTwo);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]?.unsubscribed).toBe(true);
    expect(subscriptions[1]?.unsubscribed).toBe(false);
    expect(controller.getSnapshot().threadId).toBe(threadTwo);
  });

  test("opening replays the thread's buffered events and treats a get_state answer as ready", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const store = await controller.openExisting(threadOne);
    expect(subscriptions[0]?.options?.afterSeq).toBe(0);
    expect(store.getSnapshot().process.status).toBe("ready");
  });

  test("follows live events when the server's replay window has moved past the start", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const client = fakeClient(rpc, subscriptions);
    const liveOnly = client.subscribe.bind(client);
    const attempts: Array<number | undefined> = [];
    const controller = createSelectedThreadHistoryController({
      client: {
        ...client,
        subscribe: async (port: unknown, event: unknown, options?: SubscribeOptions) => {
          attempts.push(options?.afterSeq);
          if (options?.afterSeq === 0) {
            throw new AppFailure({
              code: "conflict",
              message: "The requested event history is no longer available",
              retryable: true,
            });
          }
          return liveOnly(port as never, event as never, options);
        },
      } as AppClient,
      folder,
    });
    await controller.openExisting(threadOne);
    expect(attempts).toEqual([0, undefined]);
    expect(controller.getSnapshot().threadId).toBe(threadOne);
  });

  test("resumes a reconnect from afterSeq without duplicate event application", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const store = await controller.openExisting(threadOne);
    await controller.resume(12);
    const event: RpcSessionEvent = { kind: "process", status: "running" };
    const resumed = subscriptions[1]?.listeners[0];
    if (!resumed) throw new Error("resume subscription did not attach");
    resumed(event, 13);
    resumed(event, 13);
    expect(subscriptions[1]?.options?.afterSeq).toBe(12);
    expect(store.getSnapshot().lastSeq).toBe(13);
    expect(store.getSnapshot().needsRefetch).toBe(false);
  });

  test("a fresh subscription's first event is its baseline, so a prompt sent during the first load keeps its live state", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    const entriesHeld = Promise.withResolvers<void>();
    const base = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const rpc = {
      ...base,
      send: async (args: { threadId: ThreadId; command: { type: string } }) => {
        calls.push({ type: args.command.type, threadId: args.threadId });
        if (args.command.type === "get_entries") await entriesHeld.promise;
        return args.command.type === "get_state"
          ? { sessionId: args.threadId }
          : { entries: [], leafId: null };
      },
    } as unknown as RpcSessionClient;
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const opening = controller.openExisting(threadOne);
    await vi.waitFor(() => expect(subscriptions[0]?.listeners).toHaveLength(1));
    const live = subscriptions[0]?.listeners[0];
    if (!live) throw new Error("initial subscription did not attach");
    // The prompt's first events arrive while the first history load waits for its entries.
    live({ kind: "omp", event: { type: "agent_start" } } as RpcSessionEvent, 6);
    live(
      {
        kind: "omp",
        event: {
          type: "tool_execution_start",
          toolCallId: "bash-1",
          toolName: "bash",
          args: { command: "sleep 20; echo first" },
        },
      } as RpcSessionEvent,
      7,
    );
    entriesHeld.resolve();
    const store = await opening;
    const snapshot = store.getSnapshot();
    expect(snapshot.needsRefetch).toBe(false);
    expect(snapshot.prompt.streaming).toBe(true);
    expect(
      Object.values(snapshot.tools).find((tool) => tool.toolCallId === "bash-1"),
    ).toMatchObject({ status: "running" });
    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_entries"]);
  });

  test("re-keys in place during a turn without replacing the streaming store", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const switched: ThreadId[] = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
      onThreadIdChange: (threadId) => {
        if (threadId) switched.push(threadId);
      },
    });
    const oldStore = await controller.openExisting(threadOne);
    const rekey = subscriptions[0]?.listeners[0];
    if (!rekey) throw new Error("initial subscription did not attach");
    oldStore.ingest({ kind: "omp", event: { type: "agent_start" } } as RpcSessionEvent, 1);
    oldStore.ingest(
      {
        kind: "omp",
        event: {
          type: "message_start",
          messageId: "live-message",
          message: { role: "assistant", content: [{ type: "text", text: "live" }] },
        },
      } as RpcSessionEvent,
      2,
    );
    rekey(
      {
        kind: "notification",
        frame: { type: "session_info_update", sessionId: threadTwo },
      } as RpcSessionEvent,
      3,
    );
    for (
      let index = 0;
      index < 100 &&
      (controller.getSnapshot().threadId !== threadTwo || !switched.includes(threadTwo));
      index += 1
    ) {
      await Promise.resolve();
    }
    expect(controller.getSnapshot().threadId).toBe(threadTwo);
    expect(controller.getSnapshot().store).toBe(oldStore);
    expect(controller.getSnapshot().isLoading).toBe(false);
    expect(oldStore.getSnapshot().prompt.streaming).toBe(true);
    expect(oldStore.getSnapshot().messageOrder.length).toBeGreaterThan(0);
    expect(subscriptions[0]?.unsubscribed).toBe(true);
    expect(subscriptions[1]?.options?.scope).toBe(threadTwo);
    const rekeyed = subscriptions[1]?.listeners[0];
    if (!rekeyed) throw new Error("re-keyed subscription did not attach");
    rekeyed({ kind: "session_settled", event: { type: "session_settled" } } as RpcSessionEvent, 4);
    await Promise.resolve();
    expect(oldStore.getSnapshot().prompt.streaming).toBe(false);
  });

  test("refreshes history and session state after each settled turn", async () => {
    const calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      calls,
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    await controller.openExisting(threadOne);
    const listener = subscriptions[0]?.listeners[0];
    if (!listener) throw new Error("subscription did not attach");
    calls.length = 0;
    listener({ kind: "session_settled", event: { type: "session_settled" } } as RpcSessionEvent, 1);
    for (let index = 0; index < 20 && calls.length < 2; index += 1) await Promise.resolve();
    // get_state brings the model, context and usage; get_entries pairs the turn with its entries.
    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_entries"]);
  });

  test("refreshes the open thread after a bash command, without waiting for a turn", async () => {
    const calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      calls,
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    await controller.openExisting(threadOne);
    calls.length = 0;
    await controller.refreshAfterCommand();
    // omp saves a `!` result without a turn: get_state, then the entries after the newest one.
    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_entries"]);
  });

  test("lets go of the chat on the server when it closes or switches away, and a failed release never blocks the next chat", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc((args) => ({
      threadId: (args as { threadId?: ThreadId }).threadId ?? threadOne,
      sessionFile: null,
      capabilities: {},
    }));
    const released: ThreadId[] = [];
    let failure: AppFailure | undefined;
    let silent = false;
    (rpc as unknown as { close: (args: { threadId: ThreadId }) => Promise<null> }).close = async ({
      threadId,
    }) => {
      released.push(threadId);
      if (silent) return await new Promise<null>(() => undefined);
      if (failure) throw failure;
      return null;
    };
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });

    await controller.openExisting(threadOne);
    expect(released).toEqual([]);
    await controller.openExisting(threadTwo);
    expect(released).toEqual([threadOne]);
    await controller.close();
    expect(released).toEqual([threadOne, threadTwo]);
    // Nothing is open any more, so closing again lets go of nothing.
    await controller.close();
    expect(released).toHaveLength(2);

    // A chat the server already forgot (it restarted) is not a problem.
    failure = new AppFailure({ code: "not_found", message: "gone", retryable: false });
    await controller.openExisting(threadOne);
    await expect(controller.close()).resolves.toBeUndefined();

    // A server that never answers the release does not hold up the next chat.
    silent = true;
    await controller.openExisting(threadOne);
    await controller.openExisting(threadTwo);
    expect(controller.getSnapshot().threadId).toBe(threadTwo);
    await controller.close();
    silent = false;

    // A failure that points at a bug is reported, and the next chat still opens.
    failure = new AppFailure({ code: "internal", message: "boom", retryable: false });
    const reported: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      reported.push(args);
    };
    try {
      await controller.openExisting(threadOne);
      await controller.openExisting(threadTwo);
      await vi.waitFor(() => expect(reported).toHaveLength(1));
    } finally {
      console.error = original;
    }
    expect(controller.getSnapshot().threadId).toBe(threadTwo);
  });
});

describe("SelectedThreadHistoryController reopening a saved chat", () => {
  test("a saved chat the server no longer has is replaced by a new chat in its folder", async () => {
    const opens: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opens.push(args);
      if ("threadId" in args) {
        throw new AppFailure({
          code: "not_found",
          message: `Thread ${threadOne} was not found`,
          retryable: false,
        });
      }
      return { threadId: threadTwo, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await controller.reopenSaved(threadOne);

    expect(opens).toEqual([{ threadId: threadOne }, { folderPath: folder, start: "new" }]);
    expect(controller.getSnapshot().threadId).toBe(threadTwo);
    expect(controller.getSnapshot().error).toBeNull();
  });

  test("a saved chat that still exists opens as it did before", async () => {
    const opens: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opens.push(args);
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await controller.reopenSaved(threadOne);

    expect(opens).toEqual([{ threadId: threadOne }]);
    expect(controller.getSnapshot().threadId).toBe(threadOne);
  });

  test("any other failure is reported, and no new chat is opened in its place", async () => {
    const opens: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opens.push(args);
      throw new AppFailure({ code: "permission", message: "denied", retryable: false });
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await expect(controller.reopenSaved(threadOne)).rejects.toMatchObject({
      appError: { code: "permission", message: "denied" },
    });
    expect(opens).toEqual([{ threadId: threadOne }]);
    expect(controller.getSnapshot().threadId).toBeUndefined();
  });
});
