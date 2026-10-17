import type { AppClient, AppClientSubscription, SubscribeOptions } from "@omp-app/client";
import type {
  FolderPath,
  OpenQuestionRecord,
  OpenThreadArgs,
  RpcSessionClient,
  RpcSessionEvent,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, SessionFileStore, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { SessionHistoryLoader } from "@/modules/R0/history/history";
import { OmpRuntimeStore } from "@/modules/R0/store/store";
import { createSelectedThreadHistoryController } from ".";
import { pickedModelFor, rememberPickedModel } from "./picked-model";

const folder = "/workspace/project" as FolderPath;
const threadOne = ThreadIdSchema.parse("thread-one");
const threadTwo = ThreadIdSchema.parse("thread-two");

/** The client's resync listener, as the history controller registers it for a chat's watch. */
type ResyncListener = (event: { readonly reason: string; readonly stream?: unknown }) => void;

/** Resolves when `gate` opens. Like a request on the app's client, it rejects if the request's signal aborts first. */
function untilAborted(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    gate.then(resolve, reject);
  });
}

function createRpc(
  open: (args: OpenThreadArgs) => unknown,
  calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [],
  questions: readonly OpenQuestionRecord[] = [],
  holdFirstStateRead?: Promise<void>,
  historyFailure?: () => AppFailure | undefined,
  holdHistoryRead?: Promise<void>,
  holdHistoryReadAt = 1,
  closed: ThreadId[] = [],
): RpcSessionClient {
  let historyReads = 0;
  let stateReads = 0;
  const send = async (
    args: {
      threadId: ThreadId;
      command: { type: string };
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown> => {
    calls.push({ type: args.command.type, threadId: args.threadId });
    switch (args.command.type) {
      case "get_state":
        stateReads += 1;
        // The first state read can be held: a request made meanwhile then runs while the chat is still loading.
        if (stateReads === 1 && holdFirstStateRead) {
          await untilAborted(holdFirstStateRead, options?.signal);
        }
        return { sessionId: args.threadId };
      case "get_entries": {
        historyReads += 1;
        const failure = historyFailure?.();
        if (failure) throw failure;
        if (holdHistoryRead && historyReads === holdHistoryReadAt)
          await untilAborted(holdHistoryRead, options?.signal);
        return { entries: [], leafId: null };
      }
      default:
        return undefined;
    }
  };
  return {
    open: async (args: OpenThreadArgs) => open(args),
    send: send as RpcSessionClient["send"],
    subscribe: async () => ({ stream: "A0.rpcSession/event/thread" as never }),
    answerExtensionUi: async () => null,
    openQuestions: async () => questions,
    stateFrames: async () => [],
    answerHostTool: async () => null,
    answerHostUri: async () => null,
    setSubagentSubscription: async () => ({ level: "off" }),
    setEventFilter: async () => ({ events: null }),
    restart: async () => null,
    close: async (args: { readonly threadId: ThreadId }) => {
      closed.push(args.threadId);
      return null;
    },
  } as unknown as RpcSessionClient;
}

interface SubscriptionRecord {
  readonly options?: SubscribeOptions;
  readonly listeners: Array<(event: RpcSessionEvent, seq: number) => void>;
  unsubscribed: boolean;
  /** How many subscriptions the app had made when this one was let go. */
  subscribesWhenUnsubscribed?: number;
}

function fakeClient(
  rpc: RpcSessionClient,
  subscriptions: SubscriptionRecord[],
  replayed: readonly RpcSessionEvent[] = [],
  failSubscriptionAt?: number,
): AppClient {
  let subscribeCount = 0;
  return {
    connectionState: "open",
    instanceId: "instance-1",
    port: () => rpc,
    onConnectionState: () => () => {},
    onResync: () => () => {},
    subscribe: async (_port: unknown, _event: unknown, options?: SubscribeOptions) => {
      subscribeCount += 1;
      if (subscribeCount === failSubscriptionAt) throw new Error("The connection dropped");
      const record: SubscriptionRecord = { options, listeners: [], unsubscribed: false };
      subscriptions.push(record);
      // Like the real client, the onEvent listener is attached before the request, and the events the server replays
      // arrive before the subscription is acknowledged.
      if (options?.onEvent) record.listeners.push(options.onEvent);
      for (const [index, event] of replayed.entries()) {
        options?.onEvent?.(event, index + 1);
      }
      const subscription: AppClientSubscription<RpcSessionEvent> = {
        stream: "A0.rpcSession/event/thread" as never,
        lastSeq: options?.afterSeq ?? 0,
        onEvent: (listener) => {
          if (!record.listeners.includes(listener)) record.listeners.push(listener);
          return () => {
            const index = record.listeners.indexOf(listener);
            if (index >= 0) record.listeners.splice(index, 1);
          };
        },
        unsubscribe: async () => {
          record.unsubscribed = true;
          record.subscribesWhenUnsubscribed = subscriptions.length;
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

  test("a model picked for a chat omp could not restore is passed to the open", async () => {
    const opened: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opened.push(args);
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await controller.openExisting(threadOne, { provider: "fake", modelId: "fake-model" });

    expect(opened).toEqual([
      { threadId: threadOne, model: { provider: "fake", modelId: "fake-model" } },
    ]);
  });

  test("a chat omp refuses for its saved model opens with the model remembered for it, and keeps that model", async () => {
    localStorage.clear();
    rememberPickedModel(threadOne, { provider: "fake", modelId: "fake-model" });
    const opened: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opened.push(args);
      if (!("model" in args) || args.model === undefined) {
        throw new AppFailure({
          code: "model_unavailable",
          message: "This chat used fake/gone-model, which is not available any more.",
          retryable: false,
        });
      }
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await controller.openExisting(threadOne);

    expect(opened).toEqual([
      { threadId: threadOne },
      { threadId: threadOne, model: { provider: "fake", modelId: "fake-model" } },
    ]);
    expect(pickedModelFor(threadOne)).toEqual({ provider: "fake", modelId: "fake-model" });
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

  test("a chat opened as new is marked openedNew, and a chat opened as latest is not", async () => {
    const rpc = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });
    await controller.openNew();
    expect(controller.getSnapshot().openedNew).toBe(true);
    await controller.openLatest();
    expect(controller.getSnapshot().openedNew).toBe(false);
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

  test("picking the chat that is open and loaded keeps its store, and omp is not asked to open it again", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const opened: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opened.push(args);
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const first = await controller.openExisting(threadOne);
    const again = await controller.pickExisting(threadOne);
    expect(again).toBe(first);
    expect(opened).toEqual([{ threadId: threadOne }]);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.unsubscribed).toBe(false);
    expect(controller.getSnapshot().threadId).toBe(threadOne);
  });

  test("a pick of the chat on screen made while a New chat is still opening opens that chat after it: the last pick is shown", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const opened: OpenThreadArgs[] = [];
    const newChat = Promise.withResolvers<unknown>();
    const rpc = createRpc((args) => {
      opened.push(args);
      if ("start" in args) return newChat.promise;
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    await controller.openExisting(threadOne);
    const creating = controller.openNew();
    // The pick comes while the New chat is still opening: the chat on screen is still the loaded one.
    const picked = controller.pickExisting(threadOne);
    await vi.waitFor(() => expect(opened.some((args) => "start" in args)).toBe(true));
    newChat.resolve({ threadId: threadTwo, sessionFile: null, capabilities: {} });
    await creating;
    await picked;
    expect(opened.at(-1)).toEqual({ threadId: threadOne });
    expect(controller.getSnapshot().threadId).toBe(threadOne);
  });

  test("a pick made while a latest-chat open is still pending is the chat shown, even when that open resolves after it", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const opened: OpenThreadArgs[] = [];
    const latest = Promise.withResolvers<unknown>();
    const rpc = createRpc((args) => {
      opened.push(args);
      if ("start" in args) return latest.promise;
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const opening = controller.openLatest();
    const picked = controller.pickExisting(threadOne);
    await vi.waitFor(() => expect(opened.some((args) => "start" in args)).toBe(true));
    latest.resolve({ threadId: threadTwo, sessionFile: null, capabilities: {} });
    await opening;
    await picked;
    expect(opened.at(-1)).toEqual({ threadId: threadOne });
    expect(controller.getSnapshot().threadId).toBe(threadOne);
  });

  test("a New chat asked for while a pick is still opening is the chat shown: it is the last request", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const opened: OpenThreadArgs[] = [];
    const pickOpen = Promise.withResolvers<unknown>();
    const rpc = createRpc((args) => {
      opened.push(args);
      if ("start" in args) return { threadId: threadTwo, sessionFile: null, capabilities: {} };
      return pickOpen.promise;
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const picked = controller.pickExisting(threadOne);
    await vi.waitFor(() => expect(opened.some((args) => "threadId" in args)).toBe(true));
    const creating = controller.openNew();
    pickOpen.resolve({ threadId: threadOne, sessionFile: null, capabilities: {} });
    await picked;
    await creating;
    expect(opened.at(-1)).toEqual({ folderPath: folder, start: "new" });
    expect(controller.getSnapshot().threadId).toBe(threadTwo);
  });

  test("a chat whose watch the server refused for good is reopened by the next pick of it, not left deaf", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const opened: OpenThreadArgs[] = [];
    const resyncListeners: ResyncListener[] = [];
    const rpc = createRpc((args) => {
      opened.push(args);
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const client = fakeClient(rpc, subscriptions);
    const controller = createSelectedThreadHistoryController({
      client: {
        ...client,
        onResync: (listener: ResyncListener) => {
          resyncListeners.push(listener);
          return () => {};
        },
      } as unknown as AppClient,
      folder,
    });
    await controller.openExisting(threadOne);
    // After a reconnect the server refuses the chat's resubscribe: the client reports it, and no event reaches the chat.
    for (const listener of resyncListeners) {
      listener({ reason: "subscription-failed", stream: "A0.rpcSession/event/thread" });
    }
    await controller.pickExisting(threadOne);
    expect(opened).toHaveLength(2);
    expect(subscriptions).toHaveLength(2);
  });

  test("reopening a deaf chat on its own pick keeps the chat on screen until the new one is loaded", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const opened: OpenThreadArgs[] = [];
    const resyncListeners: ResyncListener[] = [];
    const reopen = Promise.withResolvers<unknown>();
    let reopening = false;
    const rpc = createRpc((args) => {
      opened.push(args);
      if (reopening) return reopen.promise;
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const client = fakeClient(rpc, subscriptions);
    const controller = createSelectedThreadHistoryController({
      client: {
        ...client,
        onResync: (listener: ResyncListener) => {
          resyncListeners.push(listener);
          return () => {};
        },
      } as unknown as AppClient,
      folder,
    });
    const first = await controller.openExisting(threadOne);
    for (const listener of resyncListeners) {
      listener({ reason: "subscription-failed", stream: "A0.rpcSession/event/thread" });
    }
    const emptied: Array<unknown> = [];
    controller.subscribe((state) => {
      if (state.threadId === undefined || state.store === undefined) emptied.push(state.threadId);
    });
    reopening = true;
    const picked = controller.pickExisting(threadOne);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    // While omp reopens the chat, the chat on screen stays: nothing cleared it.
    expect(controller.getSnapshot().store).toBe(first);
    expect(emptied).toEqual([]);
    reopen.resolve({ threadId: threadOne, sessionFile: null, capabilities: {} });
    const second = await picked;
    expect(second).not.toBe(first);
    expect(controller.getSnapshot().store).toBe(second);
    expect(emptied).toEqual([]);
  });

  test("switching from one chat to another keeps the current store mounted until the new chat loads", async () => {
    const opened: OpenThreadArgs[] = [];
    const next = Promise.withResolvers<unknown>();
    const subscriptions: SubscriptionRecord[] = [];
    let switching = false;
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(
        createRpc((args) => {
          opened.push(args);
          return switching
            ? next.promise
            : { threadId: threadOne, sessionFile: null, capabilities: {} };
        }),
        subscriptions,
      ),
      folder,
    });
    const first = await controller.openExisting(threadOne);
    const emptyStates: number[] = [];
    controller.subscribe((state) => {
      if (state.store === undefined) emptyStates.push(emptyStates.length);
    });
    switching = true;
    const picked = controller.pickExisting(threadTwo);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(controller.getSnapshot().store).toBe(first);
    expect(controller.getSnapshot().isLoading).toBe(true);
    expect(subscriptions).toHaveLength(1);
    expect(emptyStates).toEqual([]);
    next.resolve({ threadId: threadTwo, sessionFile: null, capabilities: {} });
    const second = await picked;
    expect(second).not.toBe(first);
    expect(controller.getSnapshot().isLoading).toBe(false);
    expect(controller.getSnapshot().store).toBe(second);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]?.unsubscribed).toBe(true);
    expect(subscriptions[1]?.unsubscribed).toBe(false);
  });
  test("a failed switch keeps the current chat subscribed and usable", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(
        createRpc((args) => {
          if ("threadId" in args && args.threadId === threadTwo)
            throw new AppFailure({
              code: "internal",
              message: "The selected chat could not be opened.",
              retryable: true,
            });
          return { threadId: threadOne, sessionFile: null, capabilities: {} };
        }),
        subscriptions,
      ),
      folder,
    });
    const first = await controller.openExisting(threadOne);
    await expect(controller.openExisting(threadTwo)).rejects.toThrow(
      "The selected chat could not be opened.",
    );
    expect(controller.getSnapshot()).toMatchObject({
      threadId: threadOne,
      store: first,
      isLoading: false,
      error: null,
    });
    expect(subscriptions).toHaveLength(1);
  });

  test("a switch from a chat on screen is flagged while it is pending, and a first open or a new chat never is", async () => {
    const flagged: string[] = [];
    const gate = Promise.withResolvers<unknown>();
    let hold = false;
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(
        createRpc((args) => {
          if (hold) return gate.promise;
          return {
            threadId: "threadId" in args ? args.threadId : threadOne,
            sessionFile: null,
            capabilities: {},
          };
        }),
        [],
      ),
      folder,
    });
    controller.subscribe((state) => {
      if (state.isSwitching) flagged.push(state.store === undefined ? "no chat" : "chat on screen");
    });
    await controller.openExisting(threadOne);
    expect(flagged).toEqual([]);

    hold = true;
    const picked = controller.pickExisting(threadTwo);
    await vi.waitFor(() => expect(controller.getSnapshot().isSwitching).toBe(true));
    expect(controller.getSnapshot().store).toBeDefined();
    gate.resolve({ threadId: threadTwo, sessionFile: null, capabilities: {} });
    await picked;
    expect(controller.getSnapshot().isSwitching).toBe(false);
    expect(flagged.every((entry) => entry === "chat on screen")).toBe(true);

    hold = false;
    const flaggedBeforeNew = flagged.length;
    await controller.openNew();
    expect(flagged).toHaveLength(flaggedBeforeNew);
    expect(controller.getSnapshot().isSwitching).toBe(false);
  });

  test("a switch whose history load fails after the new chat opened ends both views and lets the new chat go", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const closed: ThreadId[] = [];
    let failing = false;
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(
        createRpc(
          (args) => ({
            threadId: "threadId" in args ? args.threadId : threadOne,
            sessionFile: null,
            capabilities: {},
          }),
          [],
          [],
          undefined,
          () =>
            failing
              ? new AppFailure({
                  code: "internal",
                  message: "The history could not be read.",
                  retryable: true,
                })
              : undefined,
          undefined,
          1,
          closed,
        ),
        subscriptions,
      ),
      folder,
    });
    await controller.openExisting(threadOne);
    failing = true;
    await expect(controller.pickExisting(threadTwo)).rejects.toThrow(
      "The history could not be read.",
    );
    expect(controller.getSnapshot()).toMatchObject({
      threadId: undefined,
      store: undefined,
      isLoading: false,
      isSwitching: false,
      error: { message: "The history could not be read." },
    });
    expect(subscriptions.map((record) => record.unsubscribed)).toEqual([true, true]);
    expect(closed).toContain(threadTwo);
  });

  test("reopening the chat on screen asks omp for it again, as a reconnect does: its store is new", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const opened: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opened.push(args);
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const first = await controller.openExisting(threadOne);
    const again = await controller.openExisting(threadOne);
    expect(again).not.toBe(first);
    expect(opened).toEqual([{ threadId: threadOne }, { threadId: threadOne }]);
  });

  test("after omp moves a chat to its branch in place, switching to the branch and picking the source each open that chat", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const opened: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opened.push(args);
      return {
        threadId: "threadId" in args ? args.threadId : threadOne,
        sessionFile: null,
        capabilities: {},
      };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const source = await controller.openExisting(threadOne);
    const moved = subscriptions[0]?.listeners[0];
    if (!moved) throw new Error("initial subscription did not attach");
    moved(
      {
        kind: "notification",
        frame: { type: "session_info_update", sessionId: threadTwo },
      } as RpcSessionEvent,
      1,
    );
    await vi.waitFor(() => expect(controller.getSnapshot().threadId).toBe(threadTwo));
    // The store on screen is still the source's: a switch to the branch must open the branch, not keep that store.
    const branch = await controller.openExisting(threadTwo);
    expect(branch).not.toBe(source);
    expect(opened.at(-1)).toEqual({ threadId: threadTwo });
    // Picking the source opens it again, so the branch's store is not shown as the source.
    const back = await controller.pickExisting(threadOne);
    expect(back).not.toBe(branch);
    expect(opened.at(-1)).toEqual({ threadId: threadOne });
    expect(controller.getSnapshot().threadId).toBe(threadOne);
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
    const attempts: Array<number | undefined> = [];
    const controller = createSelectedThreadHistoryController({
      client: {
        ...client,
        subscribe: async (port: unknown, event: unknown, options?: SubscribeOptions) => {
          attempts.push(options?.afterSeq);
          // The client itself follows live events when the server no longer holds the events after the cursor.
          return client.subscribe(port as never, event as never, {
            ...options,
            afterSeq: undefined,
          });
        },
      } as AppClient,
      folder,
    });
    const store = await controller.openExisting(threadOne);
    expect(attempts).toEqual([0]);
    expect(controller.getSnapshot().threadId).toBe(threadOne);
    // The first live event is where the stream is now: the baseline, not a gap.
    subscriptions[0]?.listeners[0]?.({ kind: "process", status: "running" }, 41);
    expect(store.getSnapshot().lastSeq).toBe(41);
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

  test("an event the server replays before it acknowledges the subscription reaches the store, from the chat's first event", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions, [
        { kind: "process", status: "ready" } as RpcSessionEvent,
      ]),
      folder,
    });
    const store = await controller.openExisting(threadOne);
    expect(subscriptions[0]?.options?.afterSeq).toBe(0);
    expect(store.getSnapshot()).toMatchObject({ lastSeq: 1, process: { status: "ready" } });
  });
  test("keeps a startup extension error when the replayed process becomes ready afterward", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions, [
        {
          kind: "notification",
          frame: {
            type: "extension_error",
            extensionPath: "/extensions/startup-error-1421.ts",
            event: "session_start",
            error: "notes index is locked",
          },
        } as RpcSessionEvent,
        {
          kind: "process",
          status: "ready",
        } as RpcSessionEvent,
      ]),
      folder,
    });
    const store = await controller.openExisting(threadOne);
    expect(store.getSnapshot().error).toEqual({
      code: "omp_error",
      message: "notes index is locked",
      retryable: false,
      heading: "An extension reported an error",
      extension: "startup-error-1421",
    });
  });

  test("a question omp is still waiting on is shown again when its chat is opened, and one it answered is not", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      [],
      [
        {
          seq: 3,
          request: {
            type: "extension_ui_request",
            id: "ui-open",
            method: "confirm",
            title: "Go on?",
            message: "",
          },
        },
      ],
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions, [
        {
          kind: "notification",
          frame: {
            type: "extension_ui_request",
            id: "ui-done",
            method: "confirm",
            title: "Done?",
            message: "",
          },
        } as RpcSessionEvent,
        {
          kind: "notification",
          frame: {
            type: "extension_ui_request",
            id: "ui-open",
            method: "confirm",
            title: "Go on?",
            message: "",
          },
        } as RpcSessionEvent,
      ]),
      folder,
    });
    const store = await controller.openExisting(threadOne);
    // Both were replayed as history, so the replay asks neither; the open one comes from the server's record.
    expect(Object.keys(store.getSnapshot().pending.extensionUi)).toEqual(["ui-open"]);
    expect(store.getSnapshot().pending.extensionUi["ui-open"]).toMatchObject({ receivedSeq: 3 });
  });

  test("a question the server replays before it acknowledges the subscription is not asked again, and a live one is", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions, [
        {
          kind: "notification",
          frame: {
            type: "extension_ui_request",
            id: "ui-old",
            method: "select",
            title: "Which database?",
            options: [],
          },
        } as RpcSessionEvent,
      ]),
      folder,
    });
    const store = await controller.openExisting(threadOne);
    expect(store.getSnapshot().lastSeq).toBe(1);
    expect(store.getSnapshot().pending.extensionUi).toEqual({});
    // A question asked after the chat opened is live: it opens.
    subscriptions[0]?.listeners[0]?.(
      {
        kind: "notification",
        frame: {
          type: "extension_ui_request",
          id: "ui-live",
          method: "select",
          title: "Which database?",
          options: [],
        },
      } as RpcSessionEvent,
      2,
    );
    expect(Object.keys(store.getSnapshot().pending.extensionUi)).toEqual(["ui-live"]);
  });

  test("a chat opened again applies only what came after its last turn ended: the turns before are the session file's", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const store = new OmpRuntimeStore({ threadId: threadOne });
    const notified: string[] = [];
    store.subscribeNotifications(["extension_ui_request"], (frame) => {
      notified.push("id" in frame ? String(frame.id) : frame.type);
    });
    const notice = (id: string, message: string) =>
      ({
        kind: "notification",
        frame: { type: "extension_ui_request", id, method: "notify", message },
      }) as RpcSessionEvent;
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions, [
        notice("notice-turn-one", "Turn one"),
        { kind: "session_settled", event: { type: "session_settled" } } as RpcSessionEvent,
        notice("notice-turn-two", "Turn two"),
      ]),
      createStore: () => store,
      folder,
    });
    await controller.openExisting(threadOne);
    expect(notified).toEqual(["notice-turn-two"]);
    expect(store.getSnapshot().lastSeq).toBe(3);
  });

  test("the open chat is saved as soon as it is open, before its history has loaded", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const entriesHeld = Promise.withResolvers<void>();
    const base = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const rpc = {
      ...base,
      send: async (args: { threadId: ThreadId; command: { type: string } }) => {
        if (args.command.type === "get_entries") await entriesHeld.promise;
        return args.command.type === "get_state"
          ? { sessionId: args.threadId }
          : { entries: [], leafId: null };
      },
    } as unknown as RpcSessionClient;
    const saved: Array<ThreadId | undefined> = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
      onThreadIdChange: (threadId) => saved.push(threadId),
    });
    const opening = controller.openExisting(threadOne);
    // The composer takes text once the chat is open, so a reload or a restart from here on must find it.
    await vi.waitFor(() => expect(controller.getSnapshot().threadId).toBe(threadOne));
    expect(controller.getSnapshot().isLoading).toBe(true);
    expect(saved).toEqual([threadOne]);
    entriesHeld.resolve();
    await opening;
    expect(saved).toEqual([threadOne]);
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
  test("keeps the new id and refetch watch when the re-key subscription fails", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      calls,
    );
    const saved: Array<ThreadId | undefined> = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions, [], 2),
      folder,
      onThreadIdChange: (threadId) => saved.push(threadId),
    });
    const store = await controller.openExisting(threadOne);
    const rekey = subscriptions[0]?.listeners[0];
    if (!rekey) throw new Error("initial subscription did not attach");

    rekey(
      {
        kind: "notification",
        frame: { type: "session_info_update", sessionId: threadTwo },
      } as RpcSessionEvent,
      1,
    );
    await vi.waitFor(() => expect(saved).toContain(threadTwo));

    expect(controller.getSnapshot().threadId).toBe(threadTwo);
    expect(controller.getSnapshot().error?.message).toBe("The connection dropped");
    store.ingest({ kind: "process", status: "running" }, 3);
    await vi.waitFor(() =>
      expect(
        calls.filter((call) => call.threadId === threadTwo && call.type === "get_entries"),
      ).toHaveLength(1),
    );
    expect(store.getSnapshot().needsRefetch).toBe(false);
  });

  test("reports a failed re-key history read and keeps its retry watch", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    const base = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    let failFirstRekeyRead = true;
    const rpc = {
      ...base,
      send: async (
        args: { readonly threadId: ThreadId; readonly command: { readonly type: string } },
        options?: { readonly signal?: AbortSignal },
      ) => {
        calls.push({ type: args.command.type, threadId: args.threadId });
        if (
          failFirstRekeyRead &&
          args.threadId === threadTwo &&
          args.command.type === "get_entries"
        ) {
          failFirstRekeyRead = false;
          throw new AppFailure({
            code: "unavailable",
            message: "The chat history could not be read.",
            retryable: true,
          });
        }
        return base.send(args as never, options);
      },
    } as unknown as RpcSessionClient;
    const saved: Array<ThreadId | undefined> = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
      onThreadIdChange: (threadId) => saved.push(threadId),
    });
    const store = await controller.openExisting(threadOne);
    const rekey = subscriptions[0]?.listeners[0];
    if (!rekey) throw new Error("initial subscription did not attach");
    rekey(
      {
        kind: "notification",
        frame: { type: "session_info_update", sessionId: threadTwo },
      } as RpcSessionEvent,
      1,
    );
    await vi.waitFor(() =>
      expect(controller.getSnapshot().error?.message).toBe("The chat history could not be read."),
    );

    expect(controller.getSnapshot().threadId).toBe(threadTwo);
    expect(saved).toContain(threadTwo);
    store.ingest({ kind: "process", status: "running" }, 3);
    await vi.waitFor(() =>
      expect(
        calls.filter((call) => call.threadId === threadTwo && call.type === "get_entries"),
      ).toHaveLength(2),
    );
    expect(store.getSnapshot().needsRefetch).toBe(false);
  });

  test("does not report a superseded re-key refetch, but still saves the new id and keeps watching", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    const stateReadStarted = Promise.withResolvers<void>();
    const neverReleased = Promise.withResolvers<void>();
    const base = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    let holdRekeyStateRead = true;
    const rpc = {
      ...base,
      send: async (
        args: { readonly threadId: ThreadId; readonly command: { readonly type: string } },
        options?: { readonly signal?: AbortSignal },
      ) => {
        calls.push({ type: args.command.type, threadId: args.threadId });
        if (
          holdRekeyStateRead &&
          args.threadId === threadTwo &&
          args.command.type === "get_state"
        ) {
          holdRekeyStateRead = false;
          stateReadStarted.resolve();
          await untilAborted(neverReleased.promise, options?.signal);
        }
        return base.send(args as never, options);
      },
    } as unknown as RpcSessionClient;
    const saved: Array<ThreadId | undefined> = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
      onThreadIdChange: (threadId) => saved.push(threadId),
    });
    const store = await controller.openExisting(threadOne);
    const rekey = subscriptions[0]?.listeners[0];
    if (!rekey) throw new Error("initial subscription did not attach");
    rekey(
      {
        kind: "notification",
        frame: { type: "session_info_update", sessionId: threadTwo },
      } as RpcSessionEvent,
      1,
    );
    await stateReadStarted.promise;

    const rekeyed = subscriptions[1]?.listeners[0];
    if (!rekeyed) throw new Error("re-keyed subscription did not attach");
    rekeyed({ kind: "session_settled", event: { type: "session_settled" } } as RpcSessionEvent, 2);
    await vi.waitFor(() => expect(saved).toContain(threadTwo));

    expect(controller.getSnapshot().threadId).toBe(threadTwo);
    expect(controller.getSnapshot().error).toBeNull();
    await vi.waitFor(() =>
      expect(
        calls.filter((call) => call.threadId === threadTwo && call.type === "get_entries"),
      ).toHaveLength(1),
    );
    store.ingest({ kind: "process", status: "running" }, 4);
    await vi.waitFor(() =>
      expect(
        calls.filter((call) => call.threadId === threadTwo && call.type === "get_entries"),
      ).toHaveLength(2),
    );
    expect(store.getSnapshot().needsRefetch).toBe(false);
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

  test("a bash command that finishes while a new chat is still loading its history waits for that load, and the chat stays open", async () => {
    const calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    const subscriptions: SubscriptionRecord[] = [];
    let releaseFirstRead: () => void = () => undefined;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = () => resolve();
    });
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      calls,
      [],
      firstRead,
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    // The new chat is on screen, and its first history read is still in flight when the command finishes.
    const opening = controller.openNew();
    await vi.waitFor(() => expect(calls.map((call) => call.type)).toEqual(["get_state"]));
    const refreshed = controller.refreshAfterCommand();
    releaseFirstRead();
    await opening;
    await refreshed;
    const state = controller.getSnapshot();
    expect(state.error).toBeNull();
    expect(state.threadId).toBe(threadOne);
    // The refresh runs after the load: its state and entries come after the load's.
    expect(calls.map((call) => call.type)).toEqual([
      "get_state",
      "get_entries",
      "get_state",
      "get_entries",
    ]);
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

describe("SelectedThreadHistoryController when omp stops while a chat opens", () => {
  test("omp's exit while the chat's history loads keeps the chat on screen, and the exit reaches the chat's banner", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      [],
      [],
      undefined,
      () =>
        new AppFailure({
          code: "omp_exited",
          message: "omp exited (signal SIGKILL)",
          retryable: true,
        }),
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });

    const store = await controller.openExisting(threadOne);

    expect(controller.getSnapshot()).toMatchObject({
      threadId: threadOne,
      isLoading: false,
      error: { code: "omp_exited", message: "omp exited (signal SIGKILL)" },
    });
    expect(controller.getSnapshot().store).toBe(store);
    const subscription = subscriptions[0];
    expect(subscription?.unsubscribed).toBe(false);
    // omp's exit arrives on the chat's subscription, which is still open: the store takes it, and the banner shows it.
    subscription?.listeners[0]?.(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    expect(store.getSnapshot().error).toMatchObject({
      code: "omp_exited",
      message: "omp exited (signal SIGKILL)",
    });
  });
  test("reloads initial history when omp restarts after stopping during the first history read", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    let historyReads = 0;
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      [],
      [],
      undefined,
      () => {
        historyReads += 1;
        return historyReads === 1
          ? new AppFailure({
              code: "omp_exited",
              message: "omp exited (signal SIGKILL)",
              retryable: true,
            })
          : undefined;
      },
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });

    const store = await controller.openExisting(threadOne);
    const subscription = subscriptions[0];
    if (!subscription) throw new Error("history subscription did not attach");
    subscription.listeners[0]?.(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    subscription.listeners[0]?.({ kind: "process", status: "ready" } as RpcSessionEvent, 3);

    await vi.waitFor(() => expect(historyReads).toBe(2));
    expect(controller.getSnapshot()).toMatchObject({
      threadId: threadOne,
      store,
      isLoading: false,
      error: null,
    });
  });

  test("retries history only when the restarted process is ready", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const heldHistoryRead = Promise.withResolvers<void>();
    let historyReads = 0;
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      [],
      [],
      undefined,
      () => {
        historyReads += 1;
        return historyReads === 1
          ? new AppFailure({
              code: "omp_exited",
              message: "omp exited (signal SIGKILL)",
              retryable: true,
            })
          : undefined;
      },
      heldHistoryRead.promise,
      2,
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    await controller.openExisting(threadOne);
    const listener = subscriptions[0]?.listeners[0];
    if (!listener) throw new Error("history event listener did not attach");
    listener(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    listener({ kind: "process", status: "starting" } as RpcSessionEvent, 3);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(historyReads).toBe(1);
    listener({ kind: "process", status: "ready" } as RpcSessionEvent, 4);
    await vi.waitFor(() => expect(historyReads).toBe(2));
    heldHistoryRead.resolve();
  });
  test("re-arms history after a second omp exit during the retry", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    let historyReads = 0;
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      [],
      [],
      undefined,
      () => {
        historyReads += 1;
        return historyReads <= 2
          ? new AppFailure({
              code: "omp_exited",
              message: "omp exited (signal SIGKILL)",
              retryable: true,
            })
          : undefined;
      },
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const store = await controller.openExisting(threadOne);
    const subscription = subscriptions[0];
    if (!subscription) throw new Error("history subscription did not attach");
    const send = subscription.listeners[0];
    if (!send) throw new Error("history event listener did not attach");

    send(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    send({ kind: "process", status: "ready" } as RpcSessionEvent, 3);
    await vi.waitFor(() => expect(historyReads).toBe(2));
    expect(controller.getSnapshot()).toMatchObject({
      threadId: threadOne,
      store,
      isLoading: false,
      error: { code: "omp_exited" },
    });

    send(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      4,
    );
    send({ kind: "process", status: "ready" } as RpcSessionEvent, 5);
    await vi.waitFor(() => expect(historyReads).toBe(3));
    expect(controller.getSnapshot()).toMatchObject({
      threadId: threadOne,
      store,
      isLoading: false,
      error: null,
    });
  });

  test("lets the person retry a visible history-load failure", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    let historyReads = 0;
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      [],
      [],
      undefined,
      () => {
        historyReads += 1;
        if (historyReads === 1) {
          return new AppFailure({
            code: "omp_exited",
            message: "omp exited (signal SIGKILL)",
            retryable: true,
          });
        }
        return historyReads === 2
          ? new AppFailure({
              code: "permission",
              message: "The earlier messages could not be read.",
              retryable: true,
            })
          : undefined;
      },
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });
    const store = await controller.openExisting(threadOne);
    const subscription = subscriptions[0];
    if (!subscription) throw new Error("history subscription did not attach");
    const send = subscription.listeners[0];
    if (!send) throw new Error("history event listener did not attach");

    send(
      {
        kind: "process",
        status: "exited",
        error: { code: "omp_exited", message: "omp exited (signal SIGKILL)", retryable: true },
      } as RpcSessionEvent,
      2,
    );
    send({ kind: "process", status: "ready" } as RpcSessionEvent, 3);
    await vi.waitFor(() => expect(historyReads).toBe(2));
    expect(controller.getSnapshot()).toMatchObject({
      threadId: threadOne,
      store,
      isLoading: false,
      error: { code: "permission", message: "The earlier messages could not be read." },
    });

    await controller.retryHistory();
    expect(historyReads).toBe(3);
    expect(controller.getSnapshot()).toMatchObject({
      threadId: threadOne,
      store,
      isLoading: false,
      error: null,
    });
  });

  test("ignores a cancelled history retry when the chat closes", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const heldHistoryRead = Promise.withResolvers<void>();
    let historyReads = 0;
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      [],
      [],
      undefined,
      () => {
        historyReads += 1;
        return historyReads === 1
          ? new AppFailure({
              code: "omp_exited",
              message: "omp exited (signal SIGKILL)",
              retryable: true,
            })
          : undefined;
      },
      heldHistoryRead.promise,
      2,
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });

    await controller.openExisting(threadOne);
    const retry = controller.retryHistory();
    await vi.waitFor(() => expect(historyReads).toBe(2));
    expect(controller.getSnapshot().isLoading).toBe(true);
    await controller.close();
    await retry;

    expect(controller.getSnapshot()).toMatchObject({
      threadId: undefined,
      store: undefined,
      isLoading: false,
      error: null,
    });
  });
  test("ignores a cancelled history retry when refreshAfterCommand supersedes it", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const heldHistoryRead = Promise.withResolvers<void>();
    let historyReads = 0;
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      [],
      [],
      undefined,
      () => {
        historyReads += 1;
        return historyReads === 1
          ? new AppFailure({
              code: "omp_exited",
              message: "omp exited (signal SIGKILL)",
              retryable: true,
            })
          : undefined;
      },
      heldHistoryRead.promise,
      2,
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
    });

    await controller.openExisting(threadOne);
    const listener = subscriptions[0]?.listeners[0];
    if (!listener) throw new Error("history event listener did not attach");
    listener({ kind: "process", status: "ready" } as RpcSessionEvent, 2);
    await vi.waitFor(() => expect(historyReads).toBe(2));
    const refresh = controller.refreshAfterCommand();
    await vi.waitFor(() => expect(historyReads).toBe(3));
    await refresh;
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({
      threadId: threadOne,
      error: null,
    });
  });
});

describe("SelectedThreadHistoryController turns that run after the chat is left", () => {
  const settle = { kind: "session_settled", event: { type: "session_settled" } } as RpcSessionEvent;
  const start = { kind: "omp", event: { type: "agent_start" } } as RpcSessionEvent;

  /** The fake connection, with the chats it lets go of recorded in `released`. */
  function recordingRpc(
    open: (args: OpenThreadArgs) => unknown,
    released: ThreadId[],
  ): RpcSessionClient {
    return {
      ...createRpc(open),
      close: async ({ threadId }: { readonly threadId: ThreadId }) => {
        released.push(threadId);
        return null;
      },
    } as unknown as RpcSessionClient;
  }

  function openAs(args: OpenThreadArgs): unknown {
    return {
      threadId: "threadId" in args ? args.threadId : threadTwo,
      sessionFile: null,
      capabilities: {},
    };
  }

  function deliver(subscription: SubscriptionRecord | undefined, payload: RpcSessionEvent): void {
    for (const listener of [...(subscription?.listeners ?? [])]) listener(payload, 2);
  }

  test("a chat left while its turn runs stays held, and the app is told when the turn ends", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const released: ThreadId[] = [];
    const settled: ThreadId[] = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(recordingRpc(openAs, released), subscriptions),
      folder,
      onTurnSettled: (threadId) => settled.push(threadId),
    });
    const store = await controller.openExisting(threadOne);
    store.ingest(start, 1);

    await controller.openExisting(threadTwo);
    expect(released).not.toContain(threadOne);
    expect(subscriptions[0]?.unsubscribed).toBe(false);

    deliver(subscriptions[0], settle);
    await vi.waitFor(() => expect(released).toContain(threadOne));
    expect(settled).toEqual([threadOne]);
    expect(subscriptions[0]?.unsubscribed).toBe(true);
  });

  test("a chat left while idle is let go at once, and no turn end is reported", async () => {
    const released: ThreadId[] = [];
    const settled: ThreadId[] = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(recordingRpc(openAs, released), []),
      folder,
      onTurnSettled: (threadId) => settled.push(threadId),
    });
    await controller.openExisting(threadOne);

    await controller.openExisting(threadTwo);

    await vi.waitFor(() => expect(released).toEqual([threadOne]));
    expect(settled).toEqual([]);
  });

  test("a chat left while its turn runs is reported to onLeftRunning", async () => {
    const released: ThreadId[] = [];
    const leftRunning: ThreadId[] = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(recordingRpc(openAs, released), []),
      folder,
      onLeftRunning: (threadId) => leftRunning.push(threadId),
    });
    const store = await controller.openExisting(threadOne);
    store.ingest(start, 1);

    await controller.openExisting(threadTwo);

    expect(leftRunning).toEqual([threadOne]);
  });

  test("a chat left while idle, and a chat opened, are not reported to onLeftRunning", async () => {
    const released: ThreadId[] = [];
    const leftRunning: ThreadId[] = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(recordingRpc(openAs, released), []),
      folder,
      onLeftRunning: (threadId) => leftRunning.push(threadId),
    });
    await controller.openExisting(threadOne);
    expect(leftRunning).toEqual([]);

    await controller.openExisting(threadTwo);

    expect(leftRunning).toEqual([]);
  });

  test("a chat opened again while its turn still runs takes its watch over, and its turn's end is reported once", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const released: ThreadId[] = [];
    const settled: ThreadId[] = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(recordingRpc(openAs, released), subscriptions),
      folder,
      onTurnSettled: (threadId) => settled.push(threadId),
    });
    const store = await controller.openExisting(threadOne);
    store.ingest(start, 1);
    await controller.openExisting(threadTwo);

    await controller.openExisting(threadOne);
    // The watch's hold went after the open subscribed, so the stream never dropped in between.
    expect(subscriptions[0]?.unsubscribed).toBe(true);
    expect(subscriptions[0]?.subscribesWhenUnsubscribed).toBe(3);

    await vi.waitFor(() => expect(released).toContain(threadOne));
    expect(released.filter((threadId) => threadId === threadOne)).toEqual([threadOne]);
    deliver(subscriptions[0], settle);
    expect(settled).toEqual([]);
    deliver(subscriptions[subscriptions.length - 1], settle);
    expect(settled).toEqual([threadOne]);
  });

  test("a chat that stays open when its turn ends is not reported by the watch", async () => {
    const subscriptions: SubscriptionRecord[] = [];
    const settled: ThreadId[] = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(recordingRpc(openAs, []), subscriptions),
      folder,
      onTurnSettled: (threadId) => settled.push(threadId),
    });
    const store = await controller.openExisting(threadOne);
    store.ingest(start, 1);

    deliver(subscriptions[0], settle);

    expect(settled).toEqual([]);
    expect(store.getSnapshot().prompt.streaming).toBe(false);
  });
});

describe("SelectedThreadHistoryController sharing a pending open", () => {
  test("requests for a chat that is still opening share one open, and all get its store", async () => {
    const opens: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opens.push(args);
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    const stores = await Promise.all([
      controller.openExisting(threadOne),
      controller.openExisting(threadOne),
      controller.openExisting(threadOne),
    ]);

    expect(opens).toEqual([{ threadId: threadOne }]);
    expect(stores[1]).toBe(stores[0]);
    expect(stores[2]).toBe(stores[0]);
    expect(controller.getSnapshot().threadId).toBe(threadOne);
  });

  test("a request for another chat in between starts its own open, so the last pick is the one shown", async () => {
    const opens: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opens.push(args);
      return {
        threadId: "threadId" in args ? args.threadId : threadTwo,
        sessionFile: null,
        capabilities: {},
      };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await Promise.all([
      controller.openExisting(threadOne),
      controller.openExisting(threadTwo),
      controller.openExisting(threadOne),
    ]);

    expect(opens).toEqual([
      { threadId: threadOne },
      { threadId: threadTwo },
      { threadId: threadOne },
    ]);
    expect(controller.getSnapshot().threadId).toBe(threadOne);
  });

  test("a New chat asked for in between is not skipped by a later request for the chat before it", async () => {
    const opens: OpenThreadArgs[] = [];
    const rpc = createRpc((args) => {
      opens.push(args);
      return {
        threadId: "threadId" in args ? args.threadId : threadTwo,
        sessionFile: null,
        capabilities: {},
      };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await Promise.all([
      controller.openExisting(threadOne),
      controller.openNew(),
      controller.openExisting(threadOne),
    ]);

    expect(opens).toEqual([
      { threadId: threadOne },
      { folderPath: folder, start: "new" },
      { threadId: threadOne },
    ]);
    expect(controller.getSnapshot().threadId).toBe(threadOne);
  });
});

describe("SelectedThreadHistoryController closed while it is opening", () => {
  test("a chat closed while its open is pending is not saved as the open chat", async () => {
    const gate: { finish?: () => void } = {};
    const rpc = createRpc(() => {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      gate.finish = () => resolve({ threadId: threadOne, sessionFile: null, capabilities: {} });
      return promise;
    });
    const saved: Array<ThreadId | undefined> = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
      onThreadIdChange: (threadId) => saved.push(threadId),
    });

    const opening = controller.openExisting(threadOne);
    await vi.waitFor(() => expect(gate.finish).toBeDefined());
    const closing = controller.close();
    gate.finish?.();
    await Promise.all([opening, closing]);

    expect(saved).not.toContain(threadOne);
    expect(controller.getSnapshot().threadId).toBeUndefined();
  });
});

describe("SelectedThreadHistoryController whenSettled", () => {
  test("waits for a chat that is still opening, and resolves once it is open", async () => {
    const opened = Promise.withResolvers<{
      threadId: ThreadId;
      sessionFile: null;
      capabilities: Record<string, never>;
    }>();
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(
        createRpc(() => opened.promise),
        [],
      ),
      folder,
    });
    const opening = controller.openExisting(threadOne);
    let settled = false;
    const waiting = controller.whenSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    // The chat is still opening: a send made now must not be taken as the chat on screen.
    expect(settled).toBe(false);
    opened.resolve({ threadId: threadOne, sessionFile: null, capabilities: {} });
    await opening;
    await waiting;
    expect(settled).toBe(true);
    expect(controller.getSnapshot().threadId).toBe(threadOne);
  });

  test("a switch held before its open keeps the wait until the hold is released", async () => {
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(
        createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} })),
        [],
      ),
      folder,
    });
    const release = controller.holdSwitch();
    let settled = false;
    const waiting = controller.whenSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    // The page has started a New chat but has not yet asked for its chat: a send must still wait.
    expect(settled).toBe(false);
    release();
    await waiting;
    expect(settled).toBe(true);
  });

  test("a New chat's hold outlasts another chat's open, and is let go only by its own release", async () => {
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(
        createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} })),
        [],
      ),
      folder,
    });
    // This New chat's click holds the switch until its own chat is open.
    const release = controller.holdSwitch();
    // Another chat opens in the meantime: that open must not drop this hold.
    await controller.openExisting(threadTwo);
    let settled = false;
    const waiting = controller.whenSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await waiting;
    expect(settled).toBe(true);
  });

  test("waiting for a chat to open ends when the chat is on screen, not when its history has loaded", async () => {
    const entriesHeld = Promise.withResolvers<void>();
    const base = createRpc(() => ({ threadId: threadOne, sessionFile: null, capabilities: {} }));
    const rpc = {
      ...base,
      send: async (args: { threadId: ThreadId; command: { type: string } }) => {
        if (args.command.type === "get_entries") await entriesHeld.promise;
        return args.command.type === "get_state"
          ? { sessionId: args.threadId }
          : { entries: [], leafId: null };
      },
    } as unknown as RpcSessionClient;
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });
    // A new chat's history loads only once its first prompt arrives, so the open itself can stay pending.
    void controller.openExisting(threadOne);
    await controller.whenSettled();
    expect(controller.getSnapshot()).toMatchObject({ threadId: threadOne, isLoading: true });
  });
});

describe("SelectedThreadHistoryController after the connection drops while a chat opens", () => {
  test("a chat whose open lost the connection is opened again once the connection is back", async () => {
    let connectionDown = true;
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      [],
      [],
      undefined,
      () =>
        connectionDown
          ? new AppFailure({
              code: "unavailable",
              message: "The connection was lost.",
              retryable: true,
            })
          : undefined,
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await expect(controller.openExisting(threadOne)).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    expect(controller.getSnapshot().threadId).toBeUndefined();

    connectionDown = false;
    await controller.reopenFailedOpen();

    expect(controller.getSnapshot()).toMatchObject({ threadId: threadOne, error: null });
  });

  test("a chat the person closes is not opened again when the connection comes back", async () => {
    let connectionDown = true;
    const rpc = createRpc(
      () => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      [],
      [],
      undefined,
      () =>
        connectionDown
          ? new AppFailure({
              code: "unavailable",
              message: "The connection was lost.",
              retryable: true,
            })
          : undefined,
    );
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await expect(controller.openExisting(threadOne)).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    await controller.close();
    connectionDown = false;
    await controller.reopenFailedOpen();

    expect(controller.getSnapshot().threadId).toBeUndefined();
  });

  test("a pick made while the open is failing is not reopened once the connection is back", async () => {
    const lost = Promise.withResolvers<void>();
    const rpc = createRpc((args) => {
      if ("threadId" in args && args.threadId === threadOne) {
        return lost.promise.then(() => {
          throw new AppFailure({
            code: "unavailable",
            message: "The connection was lost.",
            retryable: true,
          });
        });
      }
      return { threadId: threadTwo, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    const failing = controller.openExisting(threadOne).catch(() => undefined);
    const picked = controller.openExisting(threadTwo);
    lost.resolve();
    await Promise.all([failing, picked]);
    await controller.reopenFailedOpen();

    expect(controller.getSnapshot().threadId).toBe(threadTwo);
  });

  test("a chat closed while its open is failing is not opened again", async () => {
    const lost = Promise.withResolvers<void>();
    const rpc = createRpc((args) => {
      if ("threadId" in args && args.threadId === threadOne) {
        return lost.promise.then(() => {
          throw new AppFailure({
            code: "unavailable",
            message: "The connection was lost.",
            retryable: true,
          });
        });
      }
      return { threadId: threadTwo, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    const failing = controller.openExisting(threadOne).catch(() => undefined);
    const closed = controller.close();
    lost.resolve();
    await Promise.all([failing, closed]);
    await controller.reopenFailedOpen();

    expect(controller.getSnapshot().threadId).toBeUndefined();
  });

  test("a chat closed after its open failed is not opened again when the connection comes back", async () => {
    let connectionDown = true;
    const rpc = createRpc(() => {
      if (connectionDown) {
        throw new AppFailure({
          code: "unavailable",
          message: "The connection was lost.",
          retryable: true,
        });
      }
      return { threadId: threadOne, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await expect(controller.openExisting(threadOne)).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    await controller.close();
    connectionDown = false;
    await controller.reopenFailedOpen();

    expect(controller.getSnapshot().threadId).toBeUndefined();
  });

  test("a chat the person picked after the drop is kept when the connection comes back", async () => {
    let connectionDown = true;
    const rpc = createRpc((args) => {
      const threadId = "threadId" in args ? args.threadId : threadTwo;
      if (threadId === threadOne && connectionDown) {
        throw new AppFailure({
          code: "unavailable",
          message: "The connection was lost.",
          retryable: true,
        });
      }
      return { threadId, sessionFile: null, capabilities: {} };
    });
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, []),
      folder,
    });

    await expect(controller.openExisting(threadOne)).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    await controller.openExisting(threadTwo);
    connectionDown = false;
    await controller.reopenFailedOpen();

    expect(controller.getSnapshot().threadId).toBe(threadTwo);
  });
});
