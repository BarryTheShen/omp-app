import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ServerFrame } from "@omp-app/contracts";
import {
  type AbortSignalLike,
  AppFailure,
  CapabilityMap,
  CheckpointStore,
  ConfigStore,
  DraftStore,
  ExtensionCatalog,
  FileSearchPort,
  FolderPath,
  GithubRefsPort,
  GitStatePort,
  HostMetadataPort,
  MemoryStore,
  OmpCommandGateway,
  PlanDocumentStore,
  ProviderAccountStore,
  RuleStore,
  SessionFileStore,
  SessionPinStore,
  serializeFrame,
  streamKey,
  ThreadId,
  UrlCatalogPort,
  WorkspaceStatePort,
} from "@omp-app/contracts";
import { Dispatcher, type DispatcherSocket } from "../../../dispatcher";
import { createPortRegistry } from "../../../registry/ports";
import { EventReplayHub } from "../../../replay";
import { CheckpointStoreService } from "../checkpoints";
import type { A1PortContext } from "./context";
import { createA1PortRegistrations } from "./index";

interface TestSocket extends DispatcherSocket {
  readonly frames: ServerFrame[];
  readonly closed: { code: number; reason: string }[];
}
type FakeCommandResult = {
  readonly command: string;
  readonly status: "completed";
  readonly agentInvoked: boolean;
  readonly promptSettled: boolean;
  readonly sessionSettled: boolean;
  readonly outputs: readonly [];
  readonly sessionUpdates: readonly [];
  readonly configUpdates: readonly [];
};
interface TestPinStore {
  readonly pinListeners: Set<(change: unknown) => void>;
}
function createSocket(id: string): TestSocket {
  const frames: ServerFrame[] = [];
  const closed: { code: number; reason: string }[] = [];
  return {
    id,
    frames,
    closed,
    send(frame) {
      frames.push(frame);
    },
    close(code, reason) {
      closed.push({ code, reason });
    },
  };
}

function createWelcome() {
  return {
    type: "welcome" as const,
    protocol: "omp-app/1" as const,
    instanceId: "a1-ports-test",
    serverVersion: "test",
    omp: null,
    capabilities: CapabilityMap.parse({}),
  };
}

function resultFrames(socket: TestSocket): Extract<ServerFrame, { type: "result" }>[] {
  return socket.frames.filter(
    (frame): frame is Extract<ServerFrame, { type: "result" }> => frame.type === "result",
  );
}

function eventFrames(socket: TestSocket): Extract<ServerFrame, { type: "event" }>[] {
  return socket.frames.filter(
    (frame): frame is Extract<ServerFrame, { type: "event" }> => frame.type === "event",
  );
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function hello(session: { receive(frame: string): void }): void {
  session.receive(
    serializeFrame({
      type: "hello",
      protocols: ["omp-app/1"],
      client: { name: "a1-ports-test", version: "1.0.0" },
    }),
  );
}

function commandResult(command: string): FakeCommandResult {
  return {
    command,
    status: "completed",
    agentInvoked: false,
    promptSettled: true,
    sessionSettled: true,
    outputs: [],
    sessionUpdates: [],
    configUpdates: [],
  };
}

function internalSessionFile() {
  return {
    id: "session-1",
    sessionFile: "/workspace/session.jsonl",
    version: 3,
    title: "Session",
    cwd: "/workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    assistantTurns: 0,
    sizeBytes: 10,
    status: "complete" as const,
    liveness: { lease: "free" as const, serverProcess: false },
    subagents: [],
    parseWarnings: [],
    entries: [],
  };
}

function createContext(
  options: { readonly providerFailure?: AppFailure; readonly checkpointAppData?: string } = {},
): A1PortContext {
  const pinListeners = new Set<(change: unknown) => void>();
  const session = internalSessionFile();
  const draft = {
    scope: { kind: "thread" as const, threadId: ThreadId.parse("session-1") },
    text: "",
    attachments: [],
    failedSends: [],
    revision: "revision-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const context = {
    checkpointStore: new CheckpointStoreService({ appDataDir: options.checkpointAppData }),
    sessionFileStore: {
      listSessions: async () => ({ sessions: [session], nextCursor: null, parseWarnings: [] }),
      listFolders: async () => ({ folders: ["/workspace"], nextCursor: null }),
      readSession: async () => session,
      listSubagents: async () => ({ sessionFile: session.sessionFile, transcripts: [] }),
    },
    configStore: {
      read: async () => ({
        key: "model",
        secret: false as const,
        value: "test",
        source: "global",
        overrides: [],
      }),
      list: async () => ({ entries: [], revision: "revision-1" }),
      write: async () => ({
        key: "model",
        layer: "global" as const,
        folder: null,
        revision: "revision-2",
        previousRevision: "revision-1",
        entry: {
          key: "model",
          secret: false as const,
          value: "test",
          source: "global",
          overrides: [],
        },
      }),
      subscribe: (_folder: unknown, listener: (change: unknown) => void) => {
        void listener;
        return () => undefined;
      },
    },
    draftStore: {
      get: async () => ({ draft: null }),
      save: async () => draft,
      clear: async () => ({ cleared: false, revision: null }),
    },
    ompCommandGateway: {
      run: async (args: { command: string }, _options?: { signal?: AbortSignalLike }) =>
        commandResult(args.command),
      onOutput: () => () => undefined,
    },
    sessionPinStore: {
      list: async () => ({ pins: [], revision: "revision-1", readAt: "2026-01-01T00:00:00.000Z" }),
      set: async () => ({
        sessionId: ThreadId.parse("session-1"),
        pinned: true,
        revision: "revision-2",
      }),
      subscribe: (listener: (change: unknown) => void) => {
        pinListeners.add(listener);
        return () => pinListeners.delete(listener);
      },
      pinListeners,
    },
    providerAccountStore: {
      listProviders: async () => {
        if (options.providerFailure) throw options.providerFailure;
        return { providers: [] };
      },
      listAccounts: async (args: { providerId: string }) => ({
        providerId: args.providerId,
        accounts: [],
      }),
      logout: async (args: { providerId: string; accountId: string }) => ({
        ...args,
        removed: true as const,
      }),
      pin: async (args: { sessionId: string; providerId: string; accountId: string }) => ({
        ...args,
        pinned: true as const,
      }),
      resetUsage: async (args: { providerId: string; accountId: string }) => ({
        ...args,
        reset: true as const,
      }),
    },
    extensionCatalog: {
      list: async () => ({ revision: "revision-1", extensions: [], commands: [] }),
      reload: async () => ({ revision: "revision-2", extensions: [], commands: [] }),
      subscribe: () => () => undefined,
    },
    memoryStore: {
      list: async () => ({
        parsed: true,
        rawText: "",
        entries: [],
        nextCursor: null,
        revision: "revision-1",
      }),
      get: async () => ({ entry: null }),
      write: async () => ({ entry: null, revision: "revision-1", previousRevision: "revision-0" }),
      delete: async () => ({ revision: "revision-1" }),
      clear: async () => ({ revision: "revision-1", deletedCount: 0 }),
      subscribe: () => () => undefined,
    },
    ruleStore: {
      list: async () => ({ rules: [], revision: "revision-1" }),
      read: async () => undefined,
      write: async () => undefined,
      delete: async () => ({ deleted: true, revision: "revision-1" }),
      subscribe: () => () => undefined,
    },
    githubRefs: {
      search: async () => ({ candidates: [], truncated: false }),
      currentPullRequest: async () => ({ pullRequest: null }),
    },
    urlCatalog: {
      list: async () => ({ resources: [], revision: "revision-1" }),
      refresh: async () => ({ resources: [], revision: "revision-1" }),
      subscribe: () => () => undefined,
    },
    planDocumentStore: {
      load: async () => ({ document: null, revisions: [] }),
      save: async () => undefined,
      export: async () => ({ markdown: "", revision: 0 }),
      subscribe: () => () => undefined,
    },
    readWorkspaceState: async () => ({ path: "/workspace", status: "ready", git: null }),
    searchWorkspaceFiles: async () => ({ results: [], truncated: false }),
    readHostMetadata: async () => ({ hostname: "host", displayPath: "~/code" }),
    publish: () => undefined,
    watchStreamActivity: () => () => undefined,
  };
  return context as unknown as A1PortContext;
}

function createDispatcher(context: A1PortContext): {
  dispatcher: Dispatcher;
  replay: EventReplayHub;
} {
  const replay = new EventReplayHub();
  const registrations = createA1PortRegistrations({
    ...context,
    publish: (stream, payload) => replay.publish(stream, payload),
    watchStreamActivity: (prefix, listener) => replay.registerStreamActivity(prefix, listener),
  });
  return {
    dispatcher: new Dispatcher({
      registry: createPortRegistry(registrations),
      replay,
      welcome: createWelcome(),
    }),
    replay,
  };
}

async function call(
  session: { receive(frame: string): void },
  socket: TestSocket,
  id: string,
  port: string,
  method: string,
  args: unknown,
): Promise<Extract<ServerFrame, { type: "result" }>> {
  session.receive(JSON.stringify({ type: "call", id, port, method, args }));
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = resultFrames(socket).find((frame) => frame.id === id);
    if (result) return result;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
  throw new Error(`Missing result for ${id}`);
}

describe("A1.9 port registrations", () => {
  test("routes every merged A1 port through the dispatcher", async () => {
    const { dispatcher } = createDispatcher(createContext());
    const socket = createSocket("connection-1");
    const session = dispatcher.open(socket);
    hello(session);
    const calls: Array<[string, string, unknown]> = [
      ["A1.sessionFileStore", "listSessions", { folder: "/workspace" }],
      ["A1.configStore", "list", { folder: null }],
      ["A1.draftStore", "get", { scope: { kind: "thread", threadId: "session-1" } }],
      ["A1.workspaceState", "read", { folder: "/workspace" }],
      ["A1.gitState", "read", { folder: "/workspace" }],
      ["A1.ompCommandGateway", "run", { threadId: "session-1", command: "/session" }],
      ["A1.sessionPinStore", "list", {}],
      ["A1.providerAccountStore", "listProviders", {}],
      ["A1.extensionCatalog", "list", { folder: null }],
      ["A1.fileSearch", "search", { folder: "/workspace", query: "" }],
      ["A1.hostMetadata", "read", { folder: "/workspace" }],
      ["A1.memoryStore", "list", { scope: "global", folder: null, threadId: "session-1" }],
      ["A1.planDocumentStore", "load", { threadId: "session-1" }],
      ["A1.ruleStore", "list", { scope: "global", folder: null }],
      ["A1.githubRefs", "search", { folder: "/workspace", query: "test", kind: "issue", limit: 5 }],
      ["A1.urlCatalog", "list", { query: "", limit: 10 }],
    ];
    for (const [index, [port, method, args]] of calls.entries()) {
      const result = await call(session, socket, `call-${index}`, port, method, args);
      if (!result.ok) throw new Error(`${port}.${method}: ${JSON.stringify(result.error)}`);
      expect(result.ok).toBe(true);
    }
  });
  test("registers each A1 port exactly once", () => {
    const names = createA1PortRegistrations(createContext())
      .map((registration) => registration.port.name)
      .sort();
    const expected = [
      CheckpointStore,
      ConfigStore,
      DraftStore,
      ExtensionCatalog,
      FileSearchPort,
      GithubRefsPort,
      GitStatePort,
      HostMetadataPort,
      MemoryStore,
      OmpCommandGateway,
      PlanDocumentStore,
      ProviderAccountStore,
      RuleStore,
      SessionFileStore,
      SessionPinStore,
      WorkspaceStatePort,
      UrlCatalogPort,
    ]
      .map((port) => port.name)
      .sort();
    expect(names).toEqual(expected);
    expect(new Set(names).size).toBe(names.length);
  });
  test("routes checkpoint snapshot calls through its handler", async () => {
    const workspace = join(process.cwd(), ".data", `a1-checkpoint-port-${crypto.randomUUID()}`);
    const appData = join(process.cwd(), ".data", `a1-checkpoint-app-${crypto.randomUUID()}`);
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(appData, { recursive: true });
    await fs.writeFile(join(workspace, "hello.txt"), "hello\n");
    try {
      const context = createContext({ checkpointAppData: appData });
      const { dispatcher } = createDispatcher(context);
      const socket = createSocket("connection-checkpoint");
      const session = dispatcher.open(socket);
      hello(session);
      const result = await call(
        session,
        socket,
        "checkpoint-snapshot",
        "A1.checkpointStore",
        "snapshot",
        {
          workspace: FolderPath.parse(workspace),
          conversation: {
            threadId: ThreadId.parse("session-1"),
            sessionFile: `${workspace}/session.jsonl`,
            entryId: "entry-1",
          },
          source: "manual",
          pinned: true,
        },
      );
      expect(result).toMatchObject({
        ok: true,
        value: { workspaceKey: expect.any(String), guarantee: "boundary" },
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("publishes a store change onto the scoped replay stream", async () => {
    const context = createContext();
    const { dispatcher } = createDispatcher(context);
    const socket = createSocket("connection-2");
    const session = dispatcher.open(socket);
    hello(session);
    const stream = streamKey("A1.sessionPinStore", "changed", "session-1");
    session.receive(JSON.stringify({ type: "subscribe", id: "subscription-1", stream }));
    await settle();
    const pinStore = context.sessionPinStore as unknown as TestPinStore;
    const listener = [...pinStore.pinListeners][0];
    if (!listener) throw new Error("Pin event listener was not registered.");
    listener({ sessionId: ThreadId.parse("session-1"), pinned: true, revision: "revision-2" });
    await settle();
    expect(eventFrames(socket)).toMatchObject([
      { stream, payload: { sessionId: "session-1", pinned: true, revision: "revision-2" } },
    ]);
  });

  test("maps a store AppFailure through the dispatcher", async () => {
    const failure = new AppFailure({
      code: "permission",
      message: "credential store blocked",
      retryable: false,
    });
    const { dispatcher } = createDispatcher(createContext({ providerFailure: failure }));
    const socket = createSocket("connection-3");
    const session = dispatcher.open(socket);
    hello(session);
    const result = await call(
      session,
      socket,
      "failed-provider-list",
      "A1.providerAccountStore",
      "listProviders",
      {},
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "permission", message: "credential store blocked" },
    });
  });

  test("cancels a running gateway handler through its AbortSignal", async () => {
    let abortSeen = false;
    const context = createContext();
    const gateway = {
      run: async (
        _args: unknown,
        options: { signal: { addEventListener: (type: "abort", listener: () => void) => void } },
      ) =>
        await new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            abortSeen = true;
            reject(new AppFailure({ code: "cancelled", message: "cancelled", retryable: false }));
          });
        }),
      onOutput: () => () => undefined,
    };
    const { dispatcher } = createDispatcher({
      ...context,
      ompCommandGateway: gateway,
    } as unknown as A1PortContext);
    const socket = createSocket("connection-4");
    const session = dispatcher.open(socket);
    hello(session);
    session.receive(
      JSON.stringify({
        type: "call",
        id: "running-command",
        port: "A1.ompCommandGateway",
        method: "run",
        args: { threadId: "session-1", command: "/session" },
      }),
    );
    session.receive(JSON.stringify({ type: "cancel", id: "running-command" }));
    await settle();
    expect(abortSeen).toBe(true);
    expect(resultFrames(socket).find((frame) => frame.id === "running-command")).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
  });
});
