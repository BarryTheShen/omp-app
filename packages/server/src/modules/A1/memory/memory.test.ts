import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppFailure, type MemoryChanged, MemoryScope } from "@omp-app/contracts";
import { type MemoryCommandGateway, MemoryStoreService } from "./store";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-app-memory-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function gatewayFor(outputs: Record<string, string>): {
  gateway: MemoryCommandGateway;
  commands: string[];
} {
  const commands: string[] = [];
  return {
    commands,
    gateway: {
      run: async ({ command }) => {
        commands.push(command);
        return { outputs: [{ text: outputs[command] ?? "unparseable output" }] };
      },
    },
  };
}

describe("MemoryStoreService", () => {
  test("reports unavailable without an A1.8 gateway and creates no browser/database store", async () => {
    const home = await temporaryDirectory();
    const store = new MemoryStoreService({ threadId: "thread-memory" });
    let thrown: unknown;
    try {
      await store.list({ folder: null, scope: "global" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppFailure);
    expect((thrown as AppFailure).appError).toMatchObject({
      code: "unavailable",
      capability: "host.command-gateway",
      retryable: false,
    });
    expect(await readdir(home)).toEqual([]);
    expect(MemoryScope.safeParse("global").success).toBe(true);
    store.dispose();
  });

  test("runs list/get/delete/clear through the gateway and parses renderer-shaped output", async () => {
    const firstId = "aaaaaaaaaaaaaaaa";
    const secondId = "bbbbbbbbbbbbbbbb";
    const { gateway, commands } = gatewayFor({
      "/memory mm list": `Mental models:\n- ${firstId}: Keep edits small\n- ${secondId}: Verify tests`,
      [`/memory mm show ${firstId}`]: `# ${firstId}\nKeep edits small`,
      [`/memory mm delete ${firstId}`]: `Mental model deleted: ${firstId}`,
      "/memory clear": "Memory cleared. Deleted 2 entries.",
      "/memory reset": "Memory reset.",
    });
    const store = new MemoryStoreService({ gateway, threadId: "thread-memory" });
    const list = await store.list({ folder: null, scope: "global" });
    expect(list).toMatchObject({ parsed: true, entries: [{ id: firstId }, { id: secondId }] });
    const read = await store.get({ folder: null, scope: "global", id: firstId });
    expect(read).toMatchObject({
      parsed: true,
      entry: { id: firstId, content: "Keep edits small" },
    });
    expect(
      await store.delete({
        folder: null,
        scope: "global",
        id: firstId,
        confirmed: true,
        expectedRevision: null,
      }),
    ).toMatchObject({ parsed: true });
    expect(
      await store.clear({
        folder: null,
        scope: "global",
        operation: "clear",
        confirmed: true,
        expectedRevision: null,
      }),
    ).toMatchObject({ parsed: true, deletedCount: 2 });
    await store.clear({
      folder: null,
      scope: "global",
      operation: "reset",
      confirmed: true,
      expectedRevision: null,
    });
    expect(commands).toEqual([
      "/memory mm list",
      `/memory mm show ${firstId}`,
      `/memory mm delete ${firstId}`,
      "/memory clear",
      "/memory reset",
    ]);
    store.dispose();
  });

  test("returns raw text when a renderer format cannot be parsed", async () => {
    const { gateway } = gatewayFor({ "/memory mm list": "new renderer format" });
    const store = new MemoryStoreService({ gateway, threadId: "thread-memory" });
    const result = await store.list({ folder: null, scope: "global" });
    expect(result).toMatchObject({ parsed: false, rawText: "new renderer format", entries: [] });
    store.dispose();
  });

  test("rejects unsafe memory ids before the gateway is called", async () => {
    const { gateway, commands } = gatewayFor({});
    const store = new MemoryStoreService({ gateway, threadId: "thread-memory" });
    const invalidIds = [
      "memory with space",
      "memory\nnewline",
      "--memory",
      "/memory",
      "a".repeat(65),
    ];
    for (const id of invalidIds) {
      let thrown: unknown;
      try {
        await store.get({ folder: null, scope: "global", id });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppFailure);
      expect((thrown as AppFailure).appError.code).toBe("invalid_args");
    }
    expect(commands).toEqual([]);
    store.dispose();
  });

  test("requires destructive confirmation and exposes unsupported memory editing", async () => {
    const { gateway, commands } = gatewayFor({ "/memory clear": "Memory cleared." });
    const store = new MemoryStoreService({ gateway, threadId: "thread-memory" });
    let clearError: unknown;
    try {
      await store.clear({
        folder: null,
        scope: "global",
        operation: "clear",
        confirmed: false,
        expectedRevision: null,
      });
    } catch (error) {
      clearError = error;
    }
    expect(clearError).toBeInstanceOf(AppFailure);
    expect((clearError as AppFailure).appError.code).toBe("invalid_args");
    expect(commands).toEqual([]);

    let writeError: unknown;
    try {
      await store.write({
        folder: null,
        scope: "global",
        content: "edited",
        metadata: {},
        sensitive: false,
        expectedRevision: null,
      });
    } catch (error) {
      writeError = error;
    }
    expect(writeError).toBeInstanceOf(AppFailure);
    expect((writeError as AppFailure).appError).toMatchObject({
      code: "unavailable",
      capability: "upstream.memory-edit",
    });
    store.dispose();
  });

  test("forwards command changes without owning a second memory reducer", async () => {
    const firstId = "aaaaaaaaaaaaaaaa";
    const { gateway } = gatewayFor({ [`/memory mm delete ${firstId}`]: `deleted ${firstId}` });
    const store = new MemoryStoreService({ gateway, threadId: "thread-memory" });
    const events: MemoryChanged[] = [];
    const unsubscribe = store.subscribe((event) => events.push(event));
    await store.delete({
      folder: null,
      scope: "global",
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
