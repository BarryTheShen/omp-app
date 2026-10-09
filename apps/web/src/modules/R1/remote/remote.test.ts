import type {
  OpenThreadArgs,
  OpenThreadResult,
  SessionRenameArgs,
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
    refresh: async () => undefined,
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

  test("rename sends the typed rename port, then re-reads the chat so the list shows the saved title", async () => {
    const order: string[] = [];
    const renames: SessionRenameArgs[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: {
        ...catalogSource([]),
        refresh: async (threadId) => {
          order.push(`refresh ${threadId}`);
        },
      },
      open: async () => openResult(threadOne),
      rename: async (args) => {
        order.push("rename");
        renames.push(args);
        return null;
      },
    });
    await adapter.rename(threadOne, "Renamed");
    expect(renames).toEqual([{ threadId: threadOne, name: "Renamed" }]);
    expect(order).toEqual(["rename", `refresh ${threadOne}`]);
  });

  test("a rename omp refuses keeps omp's reason, and the list is not re-read", async () => {
    const refreshed: ThreadId[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: {
        ...catalogSource([]),
        refresh: async (threadId) => {
          refreshed.push(threadId);
        },
      },
      open: async () => openResult(threadOne),
      rename: async () => {
        throw new AppFailure({
          code: "conflict",
          message: "Another omp is using this chat.",
          retryable: true,
        });
      },
    });
    await expect(adapter.rename(threadOne, "Busy")).rejects.toMatchObject({
      appError: { code: "conflict", message: "Another omp is using this chat." },
    });
    expect(refreshed).toEqual([]);
  });

  test("without the rename port a rename is unavailable, and it names the capability", async () => {
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => openResult(threadOne),
    });
    await expect(adapter.rename(threadOne, "Nope")).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "omp.cmd.set_session_name" },
    });
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

  test("lets go of the hold its open takes, so the chat is held once (by the selected-chat controller)", async () => {
    const calls: string[] = [];
    const adapter = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async (args) => {
        calls.push("threadId" in args ? `open ${args.threadId}` : "open new");
        return openResult("threadId" in args ? args.threadId : threadOne);
      },
      close: async ({ threadId }) => {
        calls.push(`close ${threadId}`);
        return null;
      },
    });
    await adapter.initialize("new");
    await adapter.switchToThread(threadTwo);
    expect(calls).toEqual([
      "open new",
      `close ${threadOne}`,
      `open ${threadTwo}`,
      `close ${threadTwo}`,
    ]);
  });

  test("a failed open holds nothing, and a failing release never fails the open", async () => {
    const released: ThreadId[] = [];
    const failing = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => {
        throw new AppFailure({ code: "permission", message: "denied", retryable: false });
      },
      close: async ({ threadId }) => {
        released.push(threadId);
        return null;
      },
    });
    await expect(failing.initialize("new")).rejects.toMatchObject({
      appError: { code: "permission" },
    });
    expect(released).toEqual([]);

    const forgetful = createNativeRemoteThreadListAdapter({
      catalog: catalogSource([]),
      open: async () => openResult(threadOne),
      close: async () => {
        throw new AppFailure({ code: "not_found", message: "gone", retryable: false });
      },
    });
    await expect(forgetful.initialize("new")).resolves.toMatchObject({ remoteId: threadOne });
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
