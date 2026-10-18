import type {
  AppClient,
  ConnectionState,
  ConnectionStateEvent,
  ResyncEvent,
} from "@omp-app/client";
import type { GitState, SessionFileChanged, SessionRunningChanged } from "@omp-app/contracts";
import { FolderPath, SessionFilePath, SessionFileStore, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SessionScope } from "../contract";
import type { SessionCatalogModel } from "./catalog";
import { watchSessionFileChanges, watchSessionRunningChanges } from "./session-changes";

type EventListener = (payload: unknown, sequence: number) => void;

interface FakeSubscription {
  readonly stream: string;
  readonly lastSeq: number;
  onEvent(listener: EventListener): () => void;
  unsubscribe(): Promise<void>;
}

interface FakeClient {
  readonly client: AppClient;
  readonly events: string[];
  readonly listeners: Map<string, Set<EventListener>>;
  readonly resyncListeners: Set<(event: ResyncEvent) => void>;
  readonly connectionListeners: Set<(event: ConnectionStateEvent) => void>;
  setConnectionState(state: ConnectionState): void;
  emit(event: string, payload: unknown): void;
  resync(event: ResyncEvent): void;
}

function fakeClient(initialState: ConnectionState = "open"): FakeClient {
  const events: string[] = [];
  const listeners = new Map<string, Set<EventListener>>();
  const resyncListeners = new Set<(event: ResyncEvent) => void>();
  const connectionListeners = new Set<(event: ConnectionStateEvent) => void>();
  let connectionState = initialState;
  let sequence = 0;
  const client = {
    get connectionState() {
      return connectionState;
    },
    subscribe: (port: unknown, event: string) => {
      if (port !== SessionFileStore) throw new Error("subscription used the wrong port");
      if (event !== "changed" && event !== "runningChanged")
        throw new Error(`unexpected session-file event: ${event}`);
      events.push(event);
      const streamListeners = listeners.get(event) ?? new Set<EventListener>();
      listeners.set(event, streamListeners);
      const subscription: FakeSubscription = {
        stream: `A1.sessionFileStore/${event}`,
        lastSeq: 0,
        onEvent: (listener) => {
          streamListeners.add(listener);
          return () => streamListeners.delete(listener);
        },
        unsubscribe: async () => {
          streamListeners.clear();
        },
      };
      return Promise.resolve(subscription);
    },
    onResync: (listener: (event: ResyncEvent) => void) => {
      resyncListeners.add(listener);
      return () => resyncListeners.delete(listener);
    },
    onConnectionState: (listener: (event: ConnectionStateEvent) => void) => {
      connectionListeners.add(listener);
      listener({ state: connectionState, attempt: 0 });
      return () => connectionListeners.delete(listener);
    },
  } as unknown as AppClient;
  return {
    client,
    events,
    listeners,
    resyncListeners,
    connectionListeners,
    setConnectionState(state) {
      connectionState = state;
      for (const listener of connectionListeners) listener({ state, attempt: 1 });
    },
    emit(event, payload) {
      sequence += 1;
      for (const listener of listeners.get(event) ?? []) listener(payload, sequence);
    },
    resync(event) {
      for (const listener of resyncListeners) listener(event);
    },
  };
}

function catalogFor(
  folder: FolderPath,
  options: { readonly scope?: SessionScope; readonly git?: GitState | null } = {},
): {
  readonly catalog: SessionCatalogModel;
  readonly listCalls: unknown[];
} {
  const listCalls: unknown[] = [];
  const scope = options.scope ?? { kind: "folder", folder };
  const filter = { scope, query: "" };
  return {
    catalog: {
      getSnapshot: () => ({ scope, filter, git: options.git ?? null }),
      list: async (args: unknown) => {
        listCalls.push(args);
        return undefined;
      },
    } as unknown as SessionCatalogModel,
    listCalls,
  };
}

const folder = FolderPath.parse("/workspace/project");
const otherFolder = FolderPath.parse("/workspace/other");
const threadId = ThreadId.parse("chat-a");
const turnStarted: SessionFileChanged = {
  folder,
  sessionFile: SessionFilePath.parse("/workspace/project/.omp/chat-a.jsonl"),
  id: threadId,
  kind: "updated",
};
const runningChanged: SessionRunningChanged = { folder, id: threadId, busy: true };

async function settle(): Promise<void> {
  for (let count = 0; count < 5; count += 1) await Promise.resolve();
}

describe("session change subscriptions", () => {
  test("subscribes to the named file event and releases it with the watch", async () => {
    const fake = fakeClient();
    const received: SessionFileChanged[] = [];
    const stop = watchSessionFileChanges(fake.client, (change) => received.push(change));
    await settle();
    expect(fake.events).toEqual(["changed"]);

    fake.emit("changed", turnStarted);
    expect(received).toEqual([turnStarted]);
    stop();
    expect(fake.listeners.get("changed")?.size).toBe(0);
  });

  test("the root running handler refreshes only the held catalog containing the event folder", async () => {
    const fake = fakeClient();
    const first = catalogFor(folder);
    const other = catalogFor(otherFolder);
    const catalogs = new Map<FolderPath, SessionCatalogModel>([
      [folder, first.catalog],
      [otherFolder, other.catalog],
    ]);
    const stop = watchSessionRunningChanges(fake.client, catalogs);
    await settle();
    expect(fake.events).toEqual(["runningChanged"]);

    fake.emit("runningChanged", runningChanged);
    expect(first.listCalls).toHaveLength(1);
    expect(other.listCalls).toHaveLength(0);
    expect(first.listCalls[0]).toMatchObject({ filter: { scope: { folder }, query: "" } });
    stop();
  });

  test("refreshes project catalogs for linked worktrees and repository roots only", async () => {
    const repositoryRoot = FolderPath.parse("/workspace/repository");
    const linkedWorktree = FolderPath.parse("/workspace/repository-worktree");
    const unrelatedFolder = FolderPath.parse("/workspace/unrelated");
    const projectScope: SessionScope = {
      kind: "project",
      folder: repositoryRoot,
      repositoryRoot,
    };
    const git: GitState = {
      repositoryRoot,
      branch: "main",
      head: "head",
      detached: false,
      dirtyFiles: [],
      ahead: 0,
      behind: 0,
      worktrees: [
        {
          path: linkedWorktree,
          head: "head-worktree",
          branch: "feature",
          detached: false,
          bare: false,
          locked: false,
        },
      ],
      observedAt: "2026-10-05T00:00:00.000Z",
    };
    const project = catalogFor(repositoryRoot, { scope: projectScope, git });
    const unrelated = catalogFor(unrelatedFolder);
    const catalogs = new Map<FolderPath, SessionCatalogModel>([
      [repositoryRoot, project.catalog],
      [unrelatedFolder, unrelated.catalog],
    ]);
    const fake = fakeClient();
    const stop = watchSessionRunningChanges(fake.client, catalogs);
    await settle();

    fake.emit("runningChanged", { folder: linkedWorktree, id: threadId, busy: true });
    expect(project.listCalls).toHaveLength(1);
    expect(unrelated.listCalls).toHaveLength(0);

    fake.emit("runningChanged", { folder: repositoryRoot, id: threadId, busy: true });
    expect(project.listCalls).toHaveLength(2);

    fake.emit("runningChanged", { folder: unrelatedFolder, id: threadId, busy: true });
    expect(project.listCalls).toHaveLength(2);
    stop();
  });

  test("refreshes every held catalog on resync and when a reconnect reopens", async () => {
    const fake = fakeClient("reconnecting");
    const first = catalogFor(folder);
    const other = catalogFor(otherFolder);
    const catalogs = new Map<FolderPath, SessionCatalogModel>([
      [folder, first.catalog],
      [otherFolder, other.catalog],
    ]);
    const stop = watchSessionRunningChanges(fake.client, catalogs);
    await settle();
    expect(fake.events).toEqual(["runningChanged"]);

    fake.resync({ reason: "gap" });
    expect(first.listCalls).toHaveLength(1);
    expect(other.listCalls).toHaveLength(1);

    fake.setConnectionState("open");
    expect(first.listCalls).toHaveLength(2);
    expect(other.listCalls).toHaveLength(2);

    stop();
    expect(fake.resyncListeners.size).toBe(0);
    expect(fake.connectionListeners.size).toBe(0);
    expect(fake.listeners.get("runningChanged")?.size).toBe(0);
  });

  test("keeps a watch that ends before its subscription arrives from leaking", async () => {
    const subscribed = Promise.withResolvers<FakeSubscription>();
    const client = {
      connectionState: "open",
      subscribe: (_port: unknown, _event: string) => subscribed.promise,
      onResync: () => () => undefined,
      onConnectionState: () => () => undefined,
    } as unknown as AppClient;
    const stop = watchSessionRunningChanges(client, new Map());
    stop();
    const released = Promise.withResolvers<void>();
    let unsubscribes = 0;
    const listeners = new Set<EventListener>();
    subscribed.resolve({
      stream: "A1.sessionFileStore/runningChanged",
      lastSeq: 0,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      unsubscribe: async () => {
        unsubscribes += 1;
        released.resolve();
      },
    });
    await released.promise;
    expect(unsubscribes).toBe(1);
    expect(listeners.size).toBe(0);
  });
});
