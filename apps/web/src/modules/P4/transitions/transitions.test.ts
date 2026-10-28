import type { CapabilityMap, ChatSessionRequest, EntryId, ThreadId } from "@omp-app/contracts";
import { AppFailure, persistedMessageKey, SessionFilePath } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { createOmpBranchingController } from "@/modules/R0/branching/branching";
import { SessionHistoryLoader } from "@/modules/R0/history/history";
import { promptResultEvent } from "@/modules/R0/store/session-events";
import { OmpRuntimeStore } from "@/modules/R0/store/store";
import type { ForkRequest } from "../contract";
import { createOmpConversationTransitionPort } from ".";

const sourceThread = "source-thread" as ThreadId;
const targetThread = "target-thread" as ThreadId;
const sourceEntry = "source-entry" as EntryId;

const capabilities: CapabilityMap = {
  "omp.cmd.branch": { state: "available", via: "rpc" },
  "omp.cmd.fork": { state: "available", via: "rpc" },
};

function entry(id: EntryId, parentId: EntryId | null, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-10-05T00:00:0${id === sourceEntry ? "1" : "2"}.000Z`,
    message: { role: "user", content: text, timestamp: id === sourceEntry ? 1 : 2 },
  };
}

function sourceStore(): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId: sourceThread });
  store.pairEndedMessages([entry(sourceEntry, null, "source text")], sourceEntry);
  return store;
}

function rpc(
  response: unknown,
  calls: Array<{ readonly threadId: ThreadId; readonly type: string }>,
  options: {
    readonly failTargetHistory?: boolean;
    readonly transitionFailure?: AppFailure;
  } = {},
): ChatSessionRequest {
  return (async ({
    threadId,
    method,
    params,
  }: {
    threadId: ThreadId;
    method: string;
    params: { readonly since?: string };
  }) => {
    calls.push({ threadId, type: method });
    if (method === "branch" || method === "fork") {
      if (options.transitionFailure) throw options.transitionFailure;
      return response as never;
    }
    if (method === "get_state") {
      if (threadId === targetThread && options.failTargetHistory) {
        throw new AppFailure({
          code: "omp_error",
          message: "new history unavailable",
          retryable: true,
        });
      }
      return { sessionId: targetThread, sessionFile: "/workspace/target.jsonl" } as never;
    }
    if (method === "get_entries") {
      return {
        entries: params.since === undefined ? [entry(sourceEntry, null, "source text")] : [],
        leafId: sourceEntry,
      } as never;
    }
    throw new Error(`Unexpected transition history request: ${method}`);
  }) as unknown as ChatSessionRequest;
}

function branchController(
  switched: ThreadId[],
  onSwitch: (threadId: ThreadId) => Promise<void> = async () => {},
): { switchTo(threadId: ThreadId): Promise<void> } {
  return {
    async switchTo(threadId) {
      switched.push(threadId);
      await onSwitch(threadId);
    },
  };
}
function activeHistoryController(
  source: OmpRuntimeStore,
  send: ChatSessionRequest,
  onStore?: (store: OmpRuntimeStore) => void,
) {
  let activeThreadId = source.getSnapshot().threadId;
  let activeStore = source;
  let activeLoader: SessionHistoryLoader | null = null;
  const branchingController = createOmpBranchingController({
    store: source,
    send,
    submitPrompt: async () => {
      throw new Error("switching session history must not submit a prompt");
    },
    switchThread: async (threadId) => {
      activeThreadId = threadId;
      activeStore = new OmpRuntimeStore({ threadId });
      onStore?.(activeStore);
      activeLoader = new SessionHistoryLoader({
        send,
        threadId,
        store: activeStore,
        readWindow: async () => ({
          sessionFile: SessionFilePath.parse("/workspace/target.jsonl"),
          leafId: sourceEntry,
          fileLastId: sourceEntry,
          entries: [entry(sourceEntry, null, "source text")],
          oldestId: sourceEntry,
          hasOlder: false,
        }),
      });
    },
    reloadHistory: async () => {
      if (!activeLoader) throw new Error("No selected session history loader");
      await activeLoader.loadInitial();
    },
  });
  return {
    branchingController,
    get activeThreadId() {
      return activeThreadId;
    },
    get activeStore() {
      return activeStore;
    },
  };
}

describe("OmpConversationTransitionPort", () => {
  test("branches through R0.4, reloads the reported identity and hydrates its active branch", async () => {
    const source = sourceStore();
    const sourceBefore = source.getSnapshot();
    const calls: Array<{ readonly threadId: ThreadId; readonly type: string }> = [];
    const targetHistory = { store: null as OmpRuntimeStore | null };
    const send = rpc({ text: "source text", cancelled: false }, calls);
    const active = activeHistoryController(source, send, (store) => {
      targetHistory.store = store;
      vi.spyOn(store, "pairEndedMessages");
    });
    const port = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      branchingController: active.branchingController,
      pickCount: () => 0,
    });

    const result = await port.branch({ threadId: sourceThread, entryId: sourceEntry });

    expect(calls).toEqual([
      { threadId: sourceThread, type: "branch" },
      { threadId: sourceThread, type: "get_state" },
      { threadId: targetThread, type: "get_state" },
      { threadId: targetThread, type: "get_entries" },
    ]);
    expect(active.activeThreadId).toBe(targetThread);
    expect(result).toEqual({
      sourceThreadId: sourceThread,
      threadId: targetThread,
      entryId: sourceEntry,
      sessionFile: "/workspace/target.jsonl",
      cancelled: false,
      reloaded: true,
      sourceRetained: true,
      wording: "conversation rewind",
    });
    expect(source.getSnapshot()).toBe(sourceBefore);
    expect(source.getSnapshot().messages).toHaveProperty(
      persistedMessageKey(sourceThread, sourceEntry),
    );
    const hydratedStore = targetHistory.store;
    if (hydratedStore === null) throw new Error("R0.4 did not create the selected target store");
    expect(hydratedStore.pairEndedMessages).toHaveBeenCalledWith(
      [expect.objectContaining({ id: sourceEntry })],
      sourceEntry,
    );
    expect(hydratedStore.getSnapshot().threadId).toBe(targetThread);
    expect(hydratedStore.getSnapshot().messages).toHaveProperty(
      persistedMessageKey(targetThread, sourceEntry),
    );
    expect(hydratedStore.getSnapshot().messageOrder).toHaveLength(1);
    const activeMessageKey = hydratedStore.getSnapshot().messageOrder[0];
    if (activeMessageKey === undefined) throw new Error("target history was not hydrated");
    expect(hydratedStore.getSnapshot().messages[activeMessageKey]?.message).toMatchObject({
      role: "user",
      content: "source text",
    });
  });
  test("forks from an entry through R0.4 and reloads without sending a prompt", async () => {
    const source = sourceStore();
    const calls: Array<{ readonly threadId: ThreadId; readonly type: string }> = [];
    const send = rpc({ cancelled: false }, calls);
    const active = activeHistoryController(source, send);
    const port = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      branchingController: active.branchingController,
      pickCount: () => 0,
    });

    const result = await port.fork({ threadId: sourceThread, entryId: sourceEntry });

    expect(calls).toEqual([
      { threadId: sourceThread, type: "fork" },
      { threadId: sourceThread, type: "get_state" },
      { threadId: targetThread, type: "get_state" },
      { threadId: targetThread, type: "get_entries" },
    ]);
    expect(active.activeThreadId).toBe(targetThread);
    expect(active.activeStore.getSnapshot().transcript.head).toBe(sourceEntry);
    expect(active.activeStore.getSnapshot().messages).toHaveProperty(
      persistedMessageKey(targetThread, sourceEntry),
    );
    expect(result).toMatchObject({
      sourceThreadId: sourceThread,
      threadId: targetThread,
      entryId: sourceEntry,
      cancelled: false,
      reloaded: true,
      sourceRetained: true,
    });
  });

  test("returns a typed cancellation and leaves the source selected", async () => {
    const source = sourceStore();
    const calls: Array<{ readonly threadId: ThreadId; readonly type: string }> = [];
    const switched: ThreadId[] = [];
    const port = createOmpConversationTransitionPort({
      store: source,
      send: rpc({ cancelled: true }, calls),
      capabilities,
      branchingController: branchController(switched),
      pickCount: () => 0,
    });

    await expect(port.fork({ threadId: sourceThread })).resolves.toEqual({
      sourceThreadId: sourceThread,
      threadId: sourceThread,
      entryId: null,
      sessionFile: null,
      cancelled: true,
      reloaded: false,
      sourceRetained: true,
    });
    expect(calls).toEqual([{ threadId: sourceThread, type: "fork" }]);
    expect(switched).toEqual([]);
    expect(source.getSnapshot().threadId).toBe(sourceThread);
  });
  test("reconciles the selected identity after an in-flight RPC cancellation", async () => {
    const source = sourceStore();
    const sourceBefore = source.getSnapshot();
    const calls: Array<{ readonly threadId: ThreadId; readonly type: string }> = [];
    const send = rpc({ cancelled: false }, calls, {
      transitionFailure: new AppFailure({
        code: "cancelled",
        message: "transition response was cancelled",
        retryable: false,
      }),
    });
    const active = activeHistoryController(source, send);
    const port = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      branchingController: active.branchingController,
      pickCount: () => 0,
    });

    await expect(port.fork({ threadId: sourceThread })).rejects.toMatchObject({
      appError: { code: "cancelled", message: "transition response was cancelled" },
    });
    expect(calls).toEqual([
      { threadId: sourceThread, type: "fork" },
      { threadId: sourceThread, type: "get_state" },
      { threadId: targetThread, type: "get_state" },
      { threadId: targetThread, type: "get_entries" },
    ]);
    expect(active.activeThreadId).toBe(targetThread);
    expect(active.activeStore.getSnapshot().messages).toHaveProperty(
      persistedMessageKey(targetThread, sourceEntry),
    );
    expect(port.getRetainedSource()).toEqual({ threadId: sourceThread, snapshot: sourceBefore });
  });

  test("does not switch or mutate the source when branch RPC fails", async () => {
    const source = sourceStore();
    const before = source.getSnapshot();
    const switched: ThreadId[] = [];
    const send = (async ({ method }: { method: string }) => {
      if (method === "branch") {
        throw new AppFailure({ code: "conflict", message: "omp is busy", retryable: true });
      }
      throw new Error("get_state should not run");
    }) as unknown as ChatSessionRequest;
    const port = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      branchingController: branchController(switched),
      pickCount: () => 0,
    });

    await expect(
      port.branch({ threadId: sourceThread, entryId: sourceEntry }),
    ).rejects.toMatchObject({
      appError: { code: "conflict", message: "omp is busy" },
    });
    expect(switched).toEqual([]);
    expect(source.getSnapshot()).toBe(before);
  });

  test("retains the source snapshot when identity reload fails", async () => {
    const source = sourceStore();
    const before = source.getSnapshot();
    const calls: Array<{ readonly threadId: ThreadId; readonly type: string }> = [];
    const send = rpc({ text: "source text", cancelled: false }, calls, {
      failTargetHistory: true,
    });
    const active = activeHistoryController(source, send);
    const port = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      branchingController: active.branchingController,
      pickCount: () => 0,
    });

    await expect(
      port.branch({ threadId: sourceThread, entryId: sourceEntry }),
    ).rejects.toMatchObject({
      appError: { code: "omp_error", message: "new history unavailable" },
    });
    expect(active.activeThreadId).toBe(targetThread);
    expect(source.getSnapshot()).toBe(before);
    expect(port.getRetainedSource()).toEqual({ threadId: sourceThread, snapshot: before });
    expect(source.getSnapshot().transcript.entries[sourceEntry]).toBeDefined();
  });
  test("serializes concurrent transitions and releases the source lock after cancellation", async () => {
    const source = sourceStore();
    const calls: Array<{ readonly threadId: ThreadId; readonly type: string }> = [];
    let release: (value: { readonly cancelled: boolean }) => void = () => {
      throw new Error("fork response was not initialized");
    };
    const pending = new Promise<{ readonly cancelled: boolean }>((resolve) => {
      release = resolve;
    });
    const send = (async ({ threadId, method }: { threadId: ThreadId; method: string }) => {
      calls.push({ threadId, type: method });
      if (method === "fork") return pending as never;
      return { sessionId: targetThread } as never;
    }) as unknown as ChatSessionRequest;
    const port = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      branchingController: branchController([]),
      pickCount: () => 0,
    });

    const first = port.fork({ threadId: sourceThread });
    await Promise.resolve();
    await expect(port.fork({ threadId: sourceThread })).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
    release({ cancelled: true });
    await expect(first).resolves.toMatchObject({ cancelled: true, sourceRetained: true });
    expect(calls).toEqual([{ threadId: sourceThread, type: "fork" }]);
  });

  test("gates missing capability and busy source before calling omp", async () => {
    const source = sourceStore();
    let calls = 0;
    const send = (async () => {
      calls += 1;
      return { cancelled: false } as never;
    }) as unknown as ChatSessionRequest;
    const unavailablePort = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities: {},
      branchingController: branchController([]),
      pickCount: () => 0,
    });
    await expect(unavailablePort.fork({ threadId: sourceThread })).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "omp.cmd.fork" },
    });

    const busyPort = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      isBusy: () => true,
      branchingController: branchController([]),
      pickCount: () => 0,
    });
    await expect(busyPort.fork({ threadId: sourceThread })).rejects.toMatchObject({
      appError: { code: "conflict" },
    });

    const unsettledSource = sourceStore();
    unsettledSource.ingest(
      promptResultEvent({
        type: "prompt_result",
        agentInvoked: false,
        status: "aborted",
        sessionSettled: false,
      }) as never,
      1,
    );
    expect(unsettledSource.getSnapshot().prompt).toMatchObject({
      admitted: true,
      streaming: false,
      sessionSettled: false,
    });
    const unsettledPort = createOmpConversationTransitionPort({
      store: unsettledSource,
      send,
      capabilities,
      branchingController: branchController([]),
      pickCount: () => 0,
    });
    await expect(unsettledPort.fork({ threadId: sourceThread })).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
    expect(calls).toBe(0);
  });

  test("rejects an identity that does not move off the source session", async () => {
    const source = sourceStore();
    const switched: ThreadId[] = [];
    const send = (async ({ method }: { method: string }) => {
      if (method === "get_state") return { sessionId: sourceThread } as never;
      return { cancelled: false } as never;
    }) as unknown as ChatSessionRequest;
    const port = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      branchingController: branchController(switched),
      pickCount: () => 0,
    });

    await expect(port.fork({ threadId: sourceThread })).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
    expect(switched).toEqual([]);
    expect(source.getSnapshot().threadId).toBe(sourceThread);
  });
  test("rejects a malformed identity while retaining the source snapshot", async () => {
    const source = sourceStore();
    const before = source.getSnapshot();
    const switched: ThreadId[] = [];
    const send = (async ({ method }: { method: string }) => {
      if (method === "branch") return { text: "", cancelled: false } as never;
      return { sessionId: "" } as never;
    }) as unknown as ChatSessionRequest;
    const port = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      branchingController: branchController(switched),
      pickCount: () => 0,
    });

    await expect(
      port.branch({ threadId: sourceThread, entryId: sourceEntry }),
    ).rejects.toMatchObject({
      appError: { code: "internal", message: "omp returned an invalid session identity" },
    });
    expect(switched).toEqual([]);
    expect(source.getSnapshot()).toBe(before);
    expect(port.getRetainedSource()).toEqual({ threadId: sourceThread, snapshot: before });
  });

  test("honors an already-aborted transition without calling omp", async () => {
    const source = sourceStore();
    const controller = new AbortController();
    controller.abort("user cancelled");
    let calls = 0;
    const send = (async () => {
      calls += 1;
      return { cancelled: false } as never;
    }) as unknown as ChatSessionRequest;
    const request: ForkRequest = { threadId: sourceThread, signal: controller.signal };
    const port = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      branchingController: branchController([]),
      pickCount: () => 0,
    });

    await expect(port.fork(request)).rejects.toMatchObject({
      appError: { code: "cancelled", message: "user cancelled" },
    });
    expect(calls).toBe(0);
  });

  test("a rewind that finishes after another chat was picked leaves the view where it is", async () => {
    const source = sourceStore();
    const calls: Array<{ readonly threadId: ThreadId; readonly type: string }> = [];
    const answer = rpc({ text: "source text", cancelled: false }, calls);
    let picks = 0;
    // The person opens another chat while omp is still answering the branch.
    const send = (async (args: { method: string }, options: unknown) => {
      const result = await answer(args as never, options as never);
      if (args.method === "branch") picks += 1;
      return result;
    }) as unknown as ChatSessionRequest;
    const switched: ThreadId[] = [];
    const port = createOmpConversationTransitionPort({
      store: source,
      send,
      capabilities,
      branchingController: branchController(switched),
      pickCount: () => picks,
    });

    const result = await port.branch({ threadId: sourceThread, entryId: sourceEntry });

    expect(switched).toEqual([]);
    expect(result).toMatchObject({ cancelled: false, reloaded: false, sourceRetained: true });
  });
});
