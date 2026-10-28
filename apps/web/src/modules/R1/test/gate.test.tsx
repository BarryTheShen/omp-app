import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppClient, AppClientSubscription, SubscribeOptions } from "@omp-app/client";
import type {
  ChatOpenResult,
  ChatSessionClient,
  ChatSessionEvent,
  Fixture,
  FolderPath,
  OpenThreadArgs,
  SessionFile,
  SessionFileChanged,
  SessionRenameArgs,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, parseFixture, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import type { RpcDuplex } from "@omp-app/omp-rpc";
import { RpcSession } from "@omp-app/omp-rpc";
import { FixtureSession } from "@omp-app/omp-rpc/fixtures";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { sessionEventOfRpc } from "@/modules/R0/store/session-events";
import { ShortcutRegistryProvider } from "@/shortcuts";
import type { DialogHost } from "../../U4/contract/dialog-host";
import { SessionActionsController } from "../actions";
import { SessionCatalogModel } from "../catalog";
import type { SessionScope } from "../contract";
import { R1_DESCRIPTORS } from "../descriptors";
import {
  R1_FIXTURE_FOLDER,
  R1_FIXTURE_REPOSITORY,
  R1_FIXTURE_WORKTREE,
  R1_HISTORY_ENTRIES,
  R1_HISTORY_STATE,
  R1_IMPORT_RESULT,
  R1_NATIVE_SESSION_FILES,
  R1_OPEN_CAPABILITIES,
  R1_PIN_LIST,
  R1_REPLAY_SCENARIO,
  R1_THREAD_IDS,
  R1_WORKSPACE_STATE,
} from "../fixtures";
import { createSelectedThreadHistoryController } from "../history";
import { createNativeRemoteThreadListAdapter } from "../remote";
import { SessionCatalogSidebar } from "../ui";

const folderScope: SessionScope = { kind: "folder", folder: R1_FIXTURE_FOLDER };
const projectScope: SessionScope = {
  kind: "project",
  folder: R1_FIXTURE_FOLDER,
  repositoryRoot: R1_FIXTURE_REPOSITORY,
};

interface CatalogFixtureClients {
  readonly sessionFiles: {
    listSessions(args: {
      readonly folder: FolderPath;
      readonly cursor?: string;
      readonly limit?: number;
    }): Promise<{ readonly sessions: SessionFile[]; readonly nextCursor: string | null }>;
    readSessionRow(args: {
      readonly sessionFile: SessionFile["sessionFile"];
    }): Promise<SessionFile>;
  };
  readonly gitState: {
    read(args: { readonly folder: FolderPath }): Promise<typeof R1_WORKSPACE_STATE>;
  };
  readonly pins: { list(): Promise<typeof R1_PIN_LIST> };
  readonly listCalls: Array<{
    readonly folder: FolderPath;
    readonly cursor?: string;
    readonly limit?: number;
  }>;
}

function createCatalogFixtureClients(options: { readonly paged: boolean }): CatalogFixtureClients {
  const bySessionFile: Record<string, SessionFile> = Object.fromEntries(
    R1_NATIVE_SESSION_FILES.map((session) => [session.sessionFile, session]),
  );
  const listCalls: Array<{
    readonly folder: FolderPath;
    readonly cursor?: string;
    readonly limit?: number;
  }> = [];

  return {
    listCalls,
    sessionFiles: {
      async listSessions(args) {
        listCalls.push(args);
        const sessions = R1_NATIVE_SESSION_FILES;
        if (options.paged && args.folder === R1_FIXTURE_FOLDER) {
          if (args.cursor === undefined) {
            return { sessions: sessions.slice(0, 2), nextCursor: "folder-page-2" };
          }
          if (args.cursor === "folder-page-2") {
            return { sessions: sessions.slice(2), nextCursor: null };
          }
        }
        return { sessions: [...sessions], nextCursor: null };
      },
      async readSessionRow({ sessionFile }) {
        const session = bySessionFile[sessionFile];
        if (!session) {
          throw new AppFailure({
            code: "not_found",
            message: "Fixture session was not found",
            retryable: false,
          });
        }
        return session;
      },
    },
    gitState: {
      async read() {
        return R1_WORKSPACE_STATE;
      },
    },
    pins: {
      async list() {
        return R1_PIN_LIST;
      },
    },
  };
}

function fixtureSessionFor(threadId: ThreadId): SessionFile | undefined {
  return R1_NATIVE_SESSION_FILES.find((session) => session.id === threadId);
}

function openResult(threadId: ThreadId): ChatOpenResult {
  const session = fixtureSessionFor(threadId) ?? fixtureSessionFor(R1_THREAD_IDS.active);
  if (!session) throw new Error("active R1 fixture session is missing");
  return { threadId, sessionFile: session.sessionFile, methods: [] };
}

interface SubscriptionRecord {
  readonly options?: SubscribeOptions;
  readonly listeners: Array<(event: ChatSessionEvent, seq: number) => void>;
  unsubscribed: boolean;
}

/** The chat session port and AppPort's capability map, as R1's controller reads them. */
function createHistoryRpc(
  open: (args: OpenThreadArgs) => Promise<ChatOpenResult>,
  calls: string[],
): ChatSessionClient {
  const request = async ({ threadId, method }: { threadId: ThreadId; method: string }) => {
    calls.push(method);
    switch (method) {
      case "get_state":
        return { ...R1_HISTORY_STATE, sessionId: threadId };
      case "get_entries":
        return { entries: R1_HISTORY_ENTRIES, leafId: "entry-assistant-1" };
      default:
        return {};
    }
  };

  return {
    open,
    request,
    capabilities: async () => R1_OPEN_CAPABILITIES,
    subscribe: async () => ({ stream: "A0.chatSession/event/thread" }) as never,
    answer: async () => null,
    openRequests: async () => [],
    uiState: async () => [],
    setSubagentSubscription: async () => ({ level: "off" }),
    restart: async () => null,
    close: async () => null,
  } as unknown as ChatSessionClient;
}

function createHistoryClient(
  rpc: ChatSessionClient,
  subscriptions: SubscriptionRecord[],
): AppClient {
  return {
    connectionState: "open",
    instanceId: "r1-fixture-instance",
    port: () => rpc,
    onConnectionState: () => () => {},
    onResync: () => () => {},
    subscribe: async (_port: unknown, _event: unknown, options?: SubscribeOptions) => {
      const record: SubscriptionRecord = { options, listeners: [], unsubscribed: false };
      subscriptions.push(record);
      // Like the real client, the onEvent listener is attached before the request.
      if (options?.onEvent) record.listeners.push(options.onEvent);
      const subscription: AppClientSubscription<ChatSessionEvent> = {
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

function loadReplayFixture(): Fixture {
  const fixturePath = fileURLToPath(
    import.meta.resolve("@omp-app/omp-rpc/fixtures/prompt-stream.fixture.jsonl"),
  );
  const text = readFileSync(fixturePath, "utf8");
  const parsed = parseFixture(text);
  if (!parsed.ok) throw new Error(`${R1_REPLAY_SCENARIO}: ${parsed.error.message}`);
  return parsed.value;
}

async function replayPromptToSubscriptions(
  subscriptions: readonly SubscriptionRecord[],
): Promise<{ readonly session: RpcSession; readonly close: () => Promise<void> }> {
  const replay = new FixtureSession({ fixture: loadReplayFixture() });
  const duplex: RpcDuplex = {
    writeLine: (line) => replay.writeLine(line),
    onChunk: (listener) => replay.onChunk((chunk) => listener(Uint8Array.from(chunk))),
    onClose: (listener) => replay.onClose(listener),
    close: () => replay.close(),
  };
  const session = new RpcSession(duplex);
  let sequence = 0;
  session.onEvent((event) => {
    sequence += 1;
    for (const subscription of subscriptions) {
      if (subscription.unsubscribed) continue;
      for (const listener of [...subscription.listeners]) {
        listener(sessionEventOfRpc(event), sequence);
      }
    }
  });
  await session.start();
  await session.send({ type: "prompt", message: "run_bash" });
  return {
    session,
    close: async () => {
      await session.close();
      replay.close();
    },
  };
}

afterEach(cleanup);

describe("R1 native catalog fixture", () => {
  test("requests folder and project roots while preserving native metadata", async () => {
    const folderClients = createCatalogFixtureClients({ paged: true });
    const folderCatalog = new SessionCatalogModel({
      scope: folderScope,
      sessionFiles: folderClients.sessionFiles,
      pins: folderClients.pins,
    });

    const firstPage = await folderCatalog.list({
      filter: { scope: folderScope, query: "" },
      limit: 50,
    });
    expect(firstPage.nextCursor).toBe("folder-page-2");
    expect(firstPage.sessions.map((session) => session.id)).toEqual([
      R1_THREAD_IDS.warning,
      R1_THREAD_IDS.active,
    ]);
    expect(firstPage.sessions[0]).toMatchObject({
      provenance: "native",
      pinned: true,
      parseWarnings: ["legacy title slot was ignored"],
      liveness: { lease: "free", serverProcess: false },
    });
    expect(firstPage.sessions[1]).toMatchObject({
      status: "pending",
      liveness: { lease: "held", serverProcess: true },
      subagents: [{ agentId: "agent-1" }],
    });

    const secondPage = await folderCatalog.list({
      filter: { scope: folderScope, query: "PARSER" },
      cursor: firstPage.nextCursor ?? undefined,
      limit: 50,
    });
    expect(secondPage.sessions.map((session) => session.id)).toEqual([R1_THREAD_IDS.untitled]);
    expect(secondPage.sessions[0]?.version).toBe(1);

    const projectClients = createCatalogFixtureClients({ paged: false });
    const projectCatalog = new SessionCatalogModel({
      scope: projectScope,
      sessionFiles: projectClients.sessionFiles,
      gitState: projectClients.gitState,
      pins: projectClients.pins,
    });
    const projectPage = await projectCatalog.list({
      filter: { scope: projectScope, query: "" },
      limit: 50,
    });
    expect(projectPage.sessions.map((session) => session.id)).toEqual([
      R1_THREAD_IDS.warning,
      R1_THREAD_IDS.active,
      R1_THREAD_IDS.worktree,
      R1_THREAD_IDS.unrelated,
      R1_THREAD_IDS.untitled,
      R1_THREAD_IDS.repository,
    ]);
    expect(projectClients.listCalls.map((call) => call.folder)).toEqual([
      R1_FIXTURE_REPOSITORY,
      R1_FIXTURE_WORKTREE,
    ]);
  });
  test("reconciles an updated native header and never resurrects a removed id", async () => {
    const clients = createCatalogFixtureClients({ paged: false });
    const original = R1_NATIVE_SESSION_FILES.find((session) => session.id === R1_THREAD_IDS.active);
    if (!original) throw new Error("active R1 fixture session is missing");
    let current = { ...original };
    const catalog = new SessionCatalogModel({
      scope: folderScope,
      sessionFiles: {
        ...clients.sessionFiles,
        readSessionRow: async () => current,
      },
    });
    await catalog.list({ filter: { scope: folderScope, query: "" }, limit: 50 });

    current = { ...current, title: "Renamed from omp", updatedAt: "2026-10-05T12:01:00.000Z" };
    const changed: SessionFileChanged = {
      folder: R1_FIXTURE_FOLDER,
      sessionFile: current.sessionFile,
      id: current.id,
      kind: "updated",
    };
    await catalog.reconcile(changed);
    expect(
      catalog.getSnapshot().sessions.find((session) => session.id === current.id),
    ).toMatchObject({
      title: "Renamed from omp",
    });

    await catalog.reconcile({ ...changed, kind: "removed" });
    expect(catalog.getSnapshot().sessions.map((session) => session.id)).not.toContain(current.id);
    current = { ...current, title: "Stale update" };
    await catalog.reconcile(changed);
    expect(catalog.getSnapshot().sessions.map((session) => session.id)).not.toContain(current.id);
  });
});

describe("R1 remote adapter and typed native actions", () => {
  test("maps assistant-ui metadata, opens new/native sessions, and gates archive", async () => {
    const clients = createCatalogFixtureClients({ paged: false });
    const catalog = new SessionCatalogModel({
      scope: folderScope,
      sessionFiles: clients.sessionFiles,
      pins: clients.pins,
    });
    await catalog.list({ filter: { scope: folderScope, query: "" }, limit: 50 });

    const opens: OpenThreadArgs[] = [];
    const renames: SessionRenameArgs[] = [];
    const newThreadId = ThreadIdSchema.parse("0199a2f0-7a4b-7d1f-9a6c-888888888888");
    const remote = createNativeRemoteThreadListAdapter({
      catalog,
      open: async (args) => {
        opens.push(args);
        return openResult("threadId" in args ? args.threadId : newThreadId);
      },
      rename: async (args) => {
        renames.push(args);
        return null;
      },
      deleteThread: async () => {},
    });

    const page = await remote.list();
    expect(page.threads.map((thread) => thread.remoteId)).toEqual([
      R1_THREAD_IDS.warning,
      R1_THREAD_IDS.active,
      R1_THREAD_IDS.worktree,
      R1_THREAD_IDS.unrelated,
      R1_THREAD_IDS.untitled,
      R1_THREAD_IDS.repository,
    ]);
    expect(page.threads[0]).toMatchObject({
      status: "regular",
      title: "Needs review",
      externalId: expect.stringContaining(".jsonl"),
      custom: {
        provenance: "native",
        pinned: true,
        parseWarnings: ["legacy title slot was ignored"],
      },
    });

    await expect(remote.initialize(R1_THREAD_IDS.active)).resolves.toMatchObject({
      remoteId: R1_THREAD_IDS.active,
    });
    await expect(remote.initialize("new")).resolves.toMatchObject({ remoteId: newThreadId });
    expect(opens).toEqual([
      { threadId: R1_THREAD_IDS.active },
      { folderPath: R1_FIXTURE_FOLDER, start: "new" },
    ]);

    await remote.rename(R1_THREAD_IDS.active, "Renamed from omp");
    expect(renames).toEqual([{ threadId: R1_THREAD_IDS.active, name: "Renamed from omp" }]);
    await expect(remote.archive(R1_THREAD_IDS.active)).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "upstream.session-archive" },
    });
  });

  test("uses A1 pin CAS and import results that expose only native identity", async () => {
    const remote = {
      rename: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const pinCalls: Array<{
      readonly sessionId: ThreadId;
      readonly pinned: boolean;
      readonly expectedRevision: string | null;
    }> = [];
    const dialogs = {
      confirm: vi.fn<DialogHost["confirm"]>(async () => true),
    } as unknown as DialogHost;
    const controller = new SessionActionsController({
      remote,
      dialogs,
      threadId: R1_THREAD_IDS.active,
      pins: {
        set: async (args) => {
          pinCalls.push(args);
          return { sessionId: args.sessionId, pinned: args.pinned, revision: "pins-r8" };
        },
      },
      imports: {
        import: async () => R1_IMPORT_RESULT,
      },
    });
    const session = R1_NATIVE_SESSION_FILES.find((item) => item.id === R1_THREAD_IDS.active);
    if (!session) throw new Error("active R1 fixture session is missing");

    await expect(
      controller.setPinned(session.id, true, R1_PIN_LIST.revision),
    ).resolves.toMatchObject({
      status: "completed",
      value: { sessionId: R1_THREAD_IDS.active, pinned: true, revision: "pins-r8" },
    });
    expect(pinCalls).toEqual([
      { sessionId: R1_THREAD_IDS.active, pinned: true, expectedRevision: "pins-r7" },
    ]);

    const imported = await controller.importForeign({
      sourceKind: "claude",
      sourceRef: "claude-fixture-session",
      folder: R1_FIXTURE_FOLDER,
    });
    expect(imported).toEqual({ status: "completed", value: R1_IMPORT_RESULT });
    expect(imported.status === "completed" ? imported.value.sessionFile : "").toContain(".jsonl");
    expect(JSON.stringify(imported)).not.toContain("transcript");

    await expect(controller.delete(session)).resolves.toMatchObject({ status: "completed" });
    expect(dialogs.confirm).toHaveBeenCalledOnce();
    expect(remote.delete).toHaveBeenCalledWith(R1_THREAD_IDS.active);
  });
});

describe("R1 W3 sidebar to history handoff", () => {
  test("opens a per-folder row before streaming a realistic omp replay into R0", async () => {
    const clients = createCatalogFixtureClients({ paged: false });
    const catalog = new SessionCatalogModel({
      scope: folderScope,
      sessionFiles: clients.sessionFiles,
      pins: clients.pins,
    });
    const subscriptions: SubscriptionRecord[] = [];
    const historyCalls: string[] = [];
    const openedByHistory: OpenThreadArgs[] = [];
    const rpc = createHistoryRpc(async (args) => {
      openedByHistory.push(args);
      return openResult("threadId" in args ? args.threadId : R1_THREAD_IDS.active);
    }, historyCalls);
    const controller = createSelectedThreadHistoryController({
      client: createHistoryClient(rpc, subscriptions),
      folder: R1_FIXTURE_FOLDER,
    });
    const openedByRemote: OpenThreadArgs[] = [];
    const remote = createNativeRemoteThreadListAdapter({
      catalog,
      open: async (args) => {
        openedByRemote.push(args);
        return openResult("threadId" in args ? args.threadId : R1_THREAD_IDS.active);
      },
    });

    const element: ReactElement = (
      <ShortcutRegistryProvider descriptors={R1_DESCRIPTORS}>
        <SessionCatalogSidebar
          catalog={catalog}
          remote={remote}
          onOpenThread={async (threadId) => {
            await controller.openExisting(threadId);
          }}
          onNewChat={async () => {
            await controller.openNew();
          }}
        />
      </ShortcutRegistryProvider>
    );
    render(element);
    await waitFor(() => expect(screen.getByText("Catalog stream")).toBeTruthy());

    fireEvent.click(screen.getByRole("option", { name: /Catalog stream/ }));
    await waitFor(() => expect(controller.getSnapshot().threadId).toBe(R1_THREAD_IDS.active));

    expect(openedByRemote).toEqual([{ threadId: R1_THREAD_IDS.active }]);
    expect(openedByHistory).toEqual([{ threadId: R1_THREAD_IDS.active }]);
    expect(historyCalls.slice(0, 2)).toEqual(["get_state", "get_entries"]);
    const store = controller.getSnapshot().store;
    expect(store).toBeDefined();
    expect(store?.getSnapshot().transcript.order).toEqual(["entry-user-1", "entry-assistant-1"]);
    expect(store?.getSnapshot().session).toMatchObject({
      model: { id: "fake-model" },
      thinkingLevel: "medium",
      sessionName: "Catalog stream",
    });

    const replay = await replayPromptToSubscriptions(subscriptions);
    try {
      const snapshot = store?.getSnapshot();
      expect(snapshot?.messages).toEqual(expect.any(Object));
      const bashTool = Object.values(snapshot?.tools ?? {}).find(
        (tool) => tool.toolName === "bash",
      );
      expect(bashTool).toMatchObject({
        toolName: "bash",
        status: "success",
        result: { content: [{ text: expect.stringContaining("fixture-tool") }] },
      });
      expect(snapshot?.messageOrder.length).toBeGreaterThan(2);
      expect(snapshot?.prompt.promptResult).toMatchObject({
        status: "completed",
        sessionSettled: true,
      });
    } finally {
      await replay.close();
      await controller.close();
    }
  });
});
