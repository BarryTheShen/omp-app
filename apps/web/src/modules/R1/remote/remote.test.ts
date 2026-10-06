import type {
  OpenThreadArgs,
  OpenThreadResult,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SessionCatalogFilter, SessionMetadata } from "../contract";
import { createNativeRemoteThreadListAdapter, type RemoteThreadCatalogSource } from ".";

const folder = "/workspace/project" as SessionMetadata["cwd"];
const scope = { kind: "folder" as const, folder };
const threadOne = ThreadIdSchema.parse("thread-one");
const threadTwo = ThreadIdSchema.parse("thread-two");

function metadata(id: ThreadId, title: string, updatedAt: string): SessionMetadata {
  return {
    id,
    sessionFile: `/workspace/project/.omp/${id}.jsonl` as SessionMetadata["sessionFile"],
    version: 3,
    title,
    firstPrompt: null,
    cwd: folder,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt,
    parentSession: null,
    messageCount: 2,
    assistantTurns: 1,
    sizeBytes: 100,
    status: "complete",
    liveness: { lease: "free", serverProcess: false },
    subagents: [],
    parseWarnings: [],
    scope,
    provenance: "native",
    pinned: false,
  };
}

function catalogSource(sessions: readonly SessionMetadata[]): RemoteThreadCatalogSource {
  const filter: SessionCatalogFilter = { scope, query: "" };
  return {
    getSnapshot: () => ({ filter }),
    list: async () => ({ sessions, nextCursor: null }),
    fetch: async (threadId) => {
      const result = sessions.find((session) => session.id === threadId);
      if (!result)
        throw new AppFailure({ code: "not_found", message: "missing", retryable: false });
      return result;
    },
  };
}

function openResult(threadId: ThreadId): OpenThreadResult {
  return {
    threadId,
    sessionFile: `/workspace/project/.omp/${threadId}.jsonl` as SessionMetadata["sessionFile"],
    capabilities: {},
  };
}

describe("NativeRemoteThreadListAdapter", () => {
  test("maps catalog metadata to assistant-ui list metadata and forwards cursors", async () => {
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([
        metadata(threadOne, "One", "2026-10-05T00:00:00.000Z"),
        metadata(threadTwo, "Two", "2026-10-04T00:00:00.000Z"),
      ]),
      open: async (args: OpenThreadArgs) =>
        openResult("threadId" in args ? args.threadId : threadOne),
    });
    const page = await adapter.list({ after: "cursor-2" });
    expect(page.threads).toMatchObject([
      { remoteId: threadOne, title: "One", status: "regular" },
      { remoteId: threadTwo, title: "Two", status: "regular" },
    ]);
    expect(page.threads[0]?.lastMessageAt).toBeInstanceOf(Date);
  });

  test("rename uses the released set_session_name RPC", async () => {
    const commands: unknown[] = [];
    const send: RpcSessionSend = async (args) => {
      commands.push(args.command);
      return undefined as never;
    };
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => openResult(threadOne),
      send,
    });
    await adapter.rename(threadOne, "Renamed");
    expect(commands).toEqual([{ type: "set_session_name", name: "Renamed" }]);
  });

  test("new-thread initialize completes open before the caller appends", async () => {
    const order: string[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => {
        order.push("start" in args && args.start === "new" ? "open-new" : "open-existing");
        return openResult(threadOne);
      },
      onThreadIdChange: () => order.push("selected"),
    });
    const result = await adapter.initialize("new");
    order.push("append");
    expect(result.remoteId).toBe(threadOne);
    expect(order).toEqual(["open-new", "selected", "append"]);
  });

  test("switching threads keeps selection callbacks ordered and stable", async () => {
    const switched: ThreadId[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => openResult("threadId" in args ? args.threadId : threadTwo),
      onThreadIdChange: (threadId) => {
        if (threadId) switched.push(threadId);
      },
    });
    await adapter.switchToThread(threadOne);
    await adapter.switchToThread(threadTwo);
    expect(switched).toEqual([threadOne, threadTwo]);
    expect(adapter.getCurrentThreadId()).toBe(threadTwo);
  });

  test("surfaces typed failures and gates unsupported archive/delete actions", async () => {
    const failure = new AppFailure({ code: "permission", message: "denied", retryable: false });
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => {
        throw failure;
      },
    });
    await expect(adapter.initialize(threadOne)).rejects.toBe(failure);
    await expect(adapter.archive(threadOne)).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    await expect(adapter.delete(threadOne)).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
  });
});
