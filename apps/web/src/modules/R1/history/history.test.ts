import type { AppClient, AppClientSubscription, SubscribeOptions } from "@omp-app/client";
import type {
  FolderPath,
  OpenThreadArgs,
  RpcSessionClient,
  RpcSessionEvent,
  ThreadId,
} from "@omp-app/contracts";
import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
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
      case "get_tree":
        return { tree: [], leafId: null };
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
  test("opens existing, loads the newest page, then delegates older pages on demand", async () => {
    const calls: Array<{ readonly type: string; readonly threadId: ThreadId }> = [];
    const subscriptions: SubscriptionRecord[] = [];
    const rpc = createRpc(
      (_args) => ({ threadId: threadOne, sessionFile: null, capabilities: {} }),
      calls,
    );
    const older: ThreadId[] = [];
    const controller = createSelectedThreadHistoryController({
      client: fakeClient(rpc, subscriptions),
      folder,
      loadOlder: async (threadId) => {
        older.push(threadId);
      },
    });

    const store = await controller.openExisting(threadOne);
    await controller.loadOlder();

    expect(store.getSnapshot().threadId).toBe(threadOne);
    expect(older).toEqual([threadOne]);
    expect(calls.map((call) => call.type)).toEqual(["get_state", "get_tree", "get_entries"]);
    expect(subscriptions).toHaveLength(1);
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

  test("re-keys after an in-process session_info_update and disposes the old stream", async () => {
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
    rekey(
      {
        kind: "notification",
        frame: { type: "session_info_update", sessionId: threadTwo },
      } as RpcSessionEvent,
      1,
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
    expect(controller.getSnapshot().store).not.toBe(oldStore);
    expect(subscriptions[0]?.unsubscribed).toBe(true);
    expect(switched).toContain(threadTwo);
  });
});
