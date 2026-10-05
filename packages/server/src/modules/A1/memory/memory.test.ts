import { describe, expect, test } from "bun:test";
import { AppFailure, type MemoryChanged, ThreadId } from "@omp-app/contracts";
import { type MemoryCommandGateway, MemoryStoreService } from "./store";

const threadId = (value: string): ThreadId => ThreadId.parse(value);

function gatewayFor(outputs: Record<string, string>): {
  gateway: MemoryCommandGateway;
  calls: Array<{ readonly threadId: string; readonly command: string }>;
} {
  const calls: Array<{ readonly threadId: string; readonly command: string }> = [];
  return {
    calls,
    gateway: {
      run: async ({ threadId, command }) => {
        calls.push({ threadId, command });
        const output =
          outputs[`${threadId}\0${command}`] ?? outputs[command] ?? "unparseable output";
        return { outputs: [{ text: output }] };
      },
    },
  };
}

describe("MemoryStoreService", () => {
  test("routes two threads to their own gateway sessions and reports closed threads", async () => {
    const firstId = "aaaaaaaaaaaaaaaa";
    const secondId = "bbbbbbbbbbbbbbbb";
    const { gateway, calls } = gatewayFor({
      "thread-one\0/memory mm list": `Mental models:\n- ${firstId}: First thread`,
      "thread-two\0/memory mm list": `Mental models:\n- ${secondId}: Second thread`,
    });
    const store = new MemoryStoreService({ gateway });

    const first = await store.list({
      folder: null,
      scope: "global",
      threadId: threadId("thread-one"),
    });
    const second = await store.list({
      folder: null,
      scope: "global",
      threadId: threadId("thread-two"),
    });
    expect(first.entries).toMatchObject([{ id: firstId, threadId: "thread-one" }]);
    expect(second.entries).toMatchObject([{ id: secondId, threadId: "thread-two" }]);
    expect(calls).toEqual([
      { threadId: "thread-one", command: "/memory mm list" },
      { threadId: "thread-two", command: "/memory mm list" },
    ]);
    store.dispose();

    const closedGateway: MemoryCommandGateway = {
      run: async () => {
        throw new AppFailure({
          code: "not_found",
          message: "No open thread thread-closed",
          retryable: false,
        });
      },
    };
    const closedStore = new MemoryStoreService({ gateway: closedGateway });
    await expect(
      closedStore.list({ folder: null, scope: "global", threadId: threadId("thread-closed") }),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
    closedStore.dispose();
  });

  test("runs list/get/delete/clear through the gateway and parses renderer-shaped output", async () => {
    const firstId = "aaaaaaaaaaaaaaaa";
    const secondId = "bbbbbbbbbbbbbbbb";
    const { gateway, calls } = gatewayFor({
      "/memory mm list": `Mental models:\n- ${firstId}: Keep edits small\n- ${secondId}: Verify tests`,
      [`/memory mm show ${firstId}`]: `# ${firstId}\nKeep edits small`,
      [`/memory mm delete ${firstId}`]: `Mental model deleted: ${firstId}`,
      "/memory clear": "Memory cleared. Deleted 2 entries.",
      "/memory reset": "Memory reset.",
    });
    const store = new MemoryStoreService({ gateway });
    const args = { folder: null, scope: "global" as const, threadId: threadId("thread-memory") };
    const list = await store.list(args);
    expect(list).toMatchObject({ parsed: true, entries: [{ id: firstId }, { id: secondId }] });
    const read = await store.get({ ...args, id: firstId });
    expect(read).toMatchObject({
      parsed: true,
      entry: { id: firstId, content: "Keep edits small" },
    });
    expect(
      await store.delete({
        ...args,
        id: firstId,
        confirmed: true,
        expectedRevision: null,
      }),
    ).toMatchObject({ parsed: true });
    expect(
      await store.clear({
        ...args,
        operation: "clear",
        confirmed: true,
        expectedRevision: null,
      }),
    ).toMatchObject({ parsed: true, deletedCount: 2 });
    await store.clear({
      ...args,
      operation: "reset",
      confirmed: true,
      expectedRevision: null,
    });
    expect(calls).toEqual([
      { threadId: "thread-memory", command: "/memory mm list" },
      { threadId: "thread-memory", command: `/memory mm show ${firstId}` },
      { threadId: "thread-memory", command: `/memory mm delete ${firstId}` },
      { threadId: "thread-memory", command: "/memory clear" },
      { threadId: "thread-memory", command: "/memory reset" },
    ]);
    store.dispose();
  });

  test("returns raw text when a renderer format cannot be parsed", async () => {
    const { gateway } = gatewayFor({ "/memory mm list": "new renderer format" });
    const store = new MemoryStoreService({ gateway });
    const result = await store.list({
      folder: null,
      scope: "global",
      threadId: threadId("thread-memory"),
    });
    expect(result).toMatchObject({ parsed: false, rawText: "new renderer format", entries: [] });
    store.dispose();
  });

  test("rejects unsafe memory ids before the gateway is called", async () => {
    const { gateway, calls } = gatewayFor({});
    const store = new MemoryStoreService({ gateway });
    const invalidIds = [
      "memory with space",
      "memory\nnewline",
      "--memory",
      "/memory",
      "a".repeat(65),
    ];
    for (const id of invalidIds) {
      await expect(
        store.get({ folder: null, scope: "global", threadId: threadId("thread-memory"), id }),
      ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    }
    expect(calls).toEqual([]);
    store.dispose();
  });

  test("requires destructive confirmation and exposes unsupported memory editing", async () => {
    const { gateway, calls } = gatewayFor({ "/memory clear": "Memory cleared." });
    const store = new MemoryStoreService({ gateway });
    const args = { folder: null, scope: "global" as const, threadId: threadId("thread-memory") };
    await expect(
      store.clear({
        ...args,
        operation: "clear",
        confirmed: false,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect(calls).toEqual([]);

    await expect(
      store.write({
        ...args,
        content: "edited",
        metadata: {},
        sensitive: false,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "upstream.memory-edit" },
    });
    store.dispose();
  });

  test("forwards command changes without owning a second memory reducer", async () => {
    const firstId = "aaaaaaaaaaaaaaaa";
    const { gateway } = gatewayFor({ [`/memory mm delete ${firstId}`]: `deleted ${firstId}` });
    const store = new MemoryStoreService({ gateway });
    const events: MemoryChanged[] = [];
    const unsubscribe = store.subscribe((event) => events.push(event));
    await store.delete({
      folder: null,
      scope: "global",
      threadId: threadId("thread-memory"),
      id: firstId,
      confirmed: true,
      expectedRevision: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ scope: "global", ids: [firstId], reason: "command" });
    unsubscribe();
    store.dispose();
  });
});
