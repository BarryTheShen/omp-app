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

function createRpc(
  open: (args: OpenThreadArgs) => unknown,
  calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [],
  questions: readonly OpenQuestionRecord[] = [],
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
    openQuestions: async () => questions,
    stateFrames: async () => [],
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

function fakeClient(
  rpc: RpcSessionClient,
  subscriptions: SubscriptionRecord[],
  replayed: readonly RpcSessionEvent[] = [],
): AppClient {
  return {
    connectionState: "open",
    instanceId: "instance-1",
    port: () => rpc,
    onConnectionState: () => () => {},
    onResync: () => () => {},
    subscribe: async (_port: unknown, _event: unknown, options?: SubscribeOptions) => {
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
