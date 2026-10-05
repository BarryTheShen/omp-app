import { describe, expect, test } from "bun:test";
import type { ServerFrame } from "@omp-app/contracts";
import { CapabilityMap, ConfigChanged, type StreamKey, streamKey } from "@omp-app/contracts";
import { Dispatcher, type DispatcherSocket } from "../../../dispatcher";
import { createPortRegistry } from "../../../registry/ports";
import { EventReplayHub } from "../../../replay";
import { createConfigStoreRegistration } from "./config-store";
import type { A1PortContext } from "./context";
import { createDraftStoreRegistration } from "./draft-store";

interface TestSocket extends DispatcherSocket {
  readonly frames: ServerFrame[];
}

function socket(id: string): TestSocket {
  const frames: ServerFrame[] = [];
  return { id, frames, send: (frame) => frames.push(frame), close: () => undefined };
}

function welcome() {
  return {
    type: "welcome" as const,
    protocol: "omp-app/1" as const,
    instanceId: "scoped-events",
    serverVersion: "test",
    omp: null,
    capabilities: CapabilityMap.parse({}),
  };
}

function hello(session: { receive(frame: string): void }): void {
  session.receive(
    JSON.stringify({
      type: "hello",
      protocols: ["omp-app/1"],
      client: { name: "scoped-events", version: "1.0.0" },
    }),
  );
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function events(socketValue: TestSocket): Extract<ServerFrame, { type: "event" }>[] {
  return socketValue.frames.filter(
    (frame): frame is Extract<ServerFrame, { type: "event" }> => frame.type === "event",
  );
}

function result(
  socketValue: TestSocket,
  id: string,
): Extract<ServerFrame, { type: "result" }> | undefined {
  return socketValue.frames.find(
    (frame): frame is Extract<ServerFrame, { type: "result" }> =>
      frame.type === "result" && frame.id === id,
  );
}

function contextWith(
  stores: { readonly configStore?: unknown; readonly draftStore?: unknown },
  replay: EventReplayHub,
): A1PortContext {
  return {
    sessionFileStore: undefined,
    configStore: stores.configStore,
    draftStore: stores.draftStore,
    ompCommandGateway: undefined,
    sessionPinStore: undefined,
    providerAccountStore: undefined,
    extensionCatalog: undefined,
    publish: (stream: StreamKey, payload: unknown) => replay.publish(stream, payload),
    watchStreamActivity: (prefix: string, listener: (stream: StreamKey, active: boolean) => void) =>
      replay.registerStreamActivity(prefix, listener),
  } as unknown as A1PortContext;
}

describe("A1 scoped event bindings", () => {
  test("starts/stops one ConfigStore watcher per active folder and isolates events", async () => {
    const replay = new EventReplayHub();
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const configStore = {
      subscribe: (folder: string | null, listener: (payload: unknown) => void) => {
        const key = folder ?? "global";
        const scoped = listeners.get(key) ?? new Set();
        scoped.add(listener);
        listeners.set(key, scoped);
        return () => {
          scoped.delete(listener);
          if (scoped.size === 0) listeners.delete(key);
        };
      },
      read: async () => undefined,
      list: async () => undefined,
      write: async () => undefined,
    };
    const registration = createConfigStoreRegistration(contextWith({ configStore }, replay));
    const dispatcher = new Dispatcher({
      registry: createPortRegistry([registration]),
      replay,
      welcome: welcome(),
    });
    const firstSocket = socket("folder-1");
    const secondSocket = socket("folder-2");
    const first = dispatcher.open(firstSocket);
    const second = dispatcher.open(secondSocket);
    hello(first);
    hello(second);
    const folderOne = "/workspace/one";
    const folderTwo = "/workspace/two";
    const streamOne = streamKey("A1.configStore", "changed", folderOne);
    const streamTwo = streamKey("A1.configStore", "changed", folderTwo);
    first.receive(JSON.stringify({ type: "subscribe", id: "sub-1", stream: streamOne }));
    second.receive(JSON.stringify({ type: "subscribe", id: "sub-2", stream: streamTwo }));
    await settle();
    expect(listeners.get(folderOne)?.size).toBe(1);
    expect(listeners.get(folderTwo)?.size).toBe(1);

    const change = ConfigChanged.parse({
      key: "model",
      layer: "project",
      folder: folderOne,
      revision: "revision-1",
      entry: { key: "model", secret: false, value: "test", source: "project", overrides: [] },
    });
    for (const listener of listeners.get(folderOne) ?? []) listener(change);
    await settle();
    expect(events(firstSocket)).toHaveLength(1);
    expect(events(secondSocket)).toHaveLength(0);

    first.receive(JSON.stringify({ type: "unsubscribe", id: "unsub-1", stream: streamOne }));
    await settle();
    expect(listeners.has(folderOne)).toBe(false);
    expect(result(firstSocket, "unsub-1")).toMatchObject({ ok: true });
    second.close();
  });

  test("starts/stops one DraftStore watcher per thread stream", async () => {
    const replay = new EventReplayHub();
    const scopes = new Map<string, number>();
    const draftStore = {
      subscribe: (
        scope: { kind: "thread" | "folder"; threadId?: string; folder?: string },
        _listener: unknown,
      ) => {
        const key = scope.kind === "thread" ? `thread:${scope.threadId}` : `folder:${scope.folder}`;
        scopes.set(key, (scopes.get(key) ?? 0) + 1);
        return () => {
          const remaining = (scopes.get(key) ?? 1) - 1;
          if (remaining === 0) scopes.delete(key);
          else scopes.set(key, remaining);
        };
      },
      get: async () => ({ draft: null }),
      save: async () => undefined,
      clear: async () => undefined,
    };
    const registration = createDraftStoreRegistration(contextWith({ draftStore }, replay));
    const dispatcher = new Dispatcher({
      registry: createPortRegistry([registration]),
      replay,
      welcome: welcome(),
    });
    const client = socket("draft-client");
    const session = dispatcher.open(client);
    hello(session);
    const stream = streamKey("A1.draftStore", "changed", "thread:thread-1");
    session.receive(JSON.stringify({ type: "subscribe", id: "sub", stream }));
    await settle();
    expect(scopes.get("thread:thread-1")).toBe(1);
    session.receive(JSON.stringify({ type: "unsubscribe", id: "unsub", stream }));
    await settle();
    expect(scopes.has("thread:thread-1")).toBe(false);
  });

  test("reconnect with afterSeq replays the retained scoped stream", () => {
    const replay = new EventReplayHub(4);
    const stream: StreamKey = streamKey("A1.configStore", "changed", "/workspace/one");
    const received: unknown[] = [];
    const dispose = replay.subscribe(stream, (frame) => received.push(frame));
    replay.publish(stream, { revision: "revision-1" });
    dispose();
    expect(received).toHaveLength(1);

    const resumed = replay.replay(stream, 0);
    expect("frames" in resumed ? resumed.frames : []).toMatchObject([
      { stream, seq: 1, payload: { revision: "revision-1" } },
    ]);
  });
});
