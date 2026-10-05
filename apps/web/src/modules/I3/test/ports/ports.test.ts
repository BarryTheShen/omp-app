import {
  AppFailure,
  type MemoryChanged,
  type MemoryGetResult,
  type MemoryListResult,
  MemoryStore,
  type RuleChanged,
  RuleStore,
  type ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  createMemoryStoreAdapter,
  createRuleStoreAdapter,
  type MemoryStoreAdapter,
  type RuleStoreAdapter,
} from "../../ports";

const folder = "/workspace/project" as MemoryListResult["entries"][number]["folder"];
const threadId = "memory-thread" as ThreadId;
const memoryId = "a".repeat(16);

function memoryList(rawText = ""): MemoryListResult {
  return { parsed: rawText.length === 0, rawText, entries: [], nextCursor: null, revision: "r1" };
}

function memoryGet(rawText = ""): MemoryGetResult {
  return { parsed: false, rawText, entry: null };
}

class FakeClient {
  readonly calls: unknown[] = [];
  readonly subscriptions: string[] = [];
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  memoryFailure: AppFailure | undefined;
  ruleFailure: AppFailure | undefined;
  memoryListResult: MemoryListResult = memoryList();

  port(port: { readonly name: string }): unknown {
    if (port.name === MemoryStore.name) {
      return {
        list: async (args: unknown) => {
          this.calls.push(["memory.list", args]);
          if (this.memoryFailure) throw this.memoryFailure;
          return this.memoryListResult;
        },
        get: async (args: unknown) => {
          this.calls.push(["memory.get", args]);
          if (this.memoryFailure) throw this.memoryFailure;
          return memoryGet();
        },
        write: async (args: unknown) => {
          this.calls.push(["memory.write", args]);
          if (this.memoryFailure) throw this.memoryFailure;
          return { parsed: true, rawText: "", entry: null, revision: "r2", previousRevision: "r1" };
        },
        delete: async (args: unknown) => {
          this.calls.push(["memory.delete", args]);
          if (this.memoryFailure) throw this.memoryFailure;
          return { parsed: true, rawText: "deleted", revision: "r2" };
        },
        clear: async (args: unknown) => {
          this.calls.push(["memory.clear", args]);
          if (this.memoryFailure) throw this.memoryFailure;
          return { parsed: true, rawText: "cleared", revision: "r2", deletedCount: 1 };
        },
      };
    }
    return {
      list: async (args: unknown) => {
        this.calls.push(["rule.list", args]);
        if (this.ruleFailure) throw this.ruleFailure;
        return { rules: [], revision: "r1" };
      },
      read: async (args: unknown) => {
        this.calls.push(["rule.read", args]);
        if (this.ruleFailure) throw this.ruleFailure;
        return {
          id: "RULES.md",
          name: "Rules",
          scope: "global",
          content: "body",
          enabled: true,
          source: "agent",
          revision: "r1",
        };
      },
      write: async (args: unknown) => {
        this.calls.push(["rule.write", args]);
        if (this.ruleFailure) throw this.ruleFailure;
        return {
          rule: {
            id: "RULES.md",
            name: "Rules",
            scope: "project",
            content: "body",
            enabled: true,
            source: "project",
            revision: "r2",
          },
          revision: "r2",
          previousRevision: "r1",
        };
      },
      delete: async (args: unknown) => {
        this.calls.push(["rule.delete", args]);
        if (this.ruleFailure) throw this.ruleFailure;
        return { deleted: true, revision: "r2" };
      },
    };
  }

  async subscribe(
    port: { readonly name: string },
    event: string,
    options: { readonly scope?: string },
  ) {
    const key = `${port.name}/${event}/${options.scope ?? ""}`;
    this.subscriptions.push(key);
    const listeners = this.listeners.get(key) ?? new Set<(payload: unknown) => void>();
    this.listeners.set(key, listeners);
    return {
      stream: key,
      lastSeq: 0,
      onEvent: (listener: (payload: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      unsubscribe: async () => {
        listeners.clear();
      },
    };
  }

  emit(key: string, payload: unknown): void {
    for (const listener of this.listeners.get(key) ?? []) listener(payload);
  }
}

describe("I3 browser port adapters", () => {
  test("routes memory calls with required thread ids", async () => {
    const fake = new FakeClient();
    const adapter: MemoryStoreAdapter = createMemoryStoreAdapter(fake as never);
    const args = { folder, scope: "session" as const, threadId, cursor: undefined };
    await expect(adapter.list(args)).resolves.toMatchObject({ parsed: true, entries: [] });
    await expect(adapter.get({ ...args, id: memoryId })).resolves.toEqual(memoryGet());
    await adapter.write({
      ...args,
      id: memoryId,
      content: "x",
      metadata: {},
      sensitive: false,
      expectedRevision: null,
    });
    await adapter.delete({ ...args, id: memoryId, confirmed: true, expectedRevision: "r1" });
    await adapter.clear({ ...args, operation: "clear", confirmed: true, expectedRevision: "r1" });
    expect(fake.calls).toEqual([
      ["memory.list", args],
      ["memory.get", { ...args, id: memoryId }],
      [
        "memory.write",
        {
          ...args,
          id: memoryId,
          content: "x",
          metadata: {},
          sensitive: false,
          expectedRevision: null,
        },
      ],
      ["memory.delete", { ...args, id: memoryId, confirmed: true, expectedRevision: "r1" }],
      ["memory.clear", { ...args, operation: "clear", confirmed: true, expectedRevision: "r1" }],
    ]);
  });
  test("keeps raw memory text when the server parser cannot classify it", async () => {
    const fake = new FakeClient();
    fake.memoryListResult = memoryList("plain omp output");
    const adapter = createMemoryStoreAdapter(fake as never);
    await expect(adapter.list({ folder, scope: "project", threadId })).resolves.toMatchObject({
      parsed: false,
      rawText: "plain omp output",
      entries: [],
    });
  });

  test("requires confirmation and rejects non-omp memory ids without calling the client", async () => {
    const fake = new FakeClient();
    const adapter = createMemoryStoreAdapter(fake as never);
    const args = {
      folder,
      scope: "project" as const,
      threadId,
      id: memoryId,
      expectedRevision: null,
    };
    await expect(adapter.delete({ ...args, confirmed: false })).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    await expect(
      adapter.clear({
        folder,
        scope: "project",
        threadId,
        operation: "reset",
        confirmed: false,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    await expect(adapter.get({ ...args, id: "not-a-memory-id" as never })).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(fake.calls).toEqual([]);
  });

  test("subscribes to memory changes by scope and preserves typed failures", async () => {
    const fake = new FakeClient();
    const adapter = createMemoryStoreAdapter(fake as never);
    const received: MemoryChanged[] = [];
    const unsubscribe = adapter.subscribeChanged({ scope: "project", folder }, (change) =>
      received.push(change),
    );
    await Promise.resolve();
    const key = `${MemoryStore.name}/changed/project:${folder}`;
    fake.emit(key, { folder, scope: "project", revision: "r1", ids: [], reason: "backend" });
    expect(fake.subscriptions).toEqual([key]);
    expect(received).toHaveLength(1);
    unsubscribe();
    fake.emit(key, { folder, scope: "project", revision: "r2", ids: [], reason: "command" });
    expect(received).toHaveLength(1);

    const failure = new AppFailure({ code: "permission", message: "denied", retryable: false });
    fake.memoryFailure = failure;
    await expect(adapter.list({ folder, scope: "project", threadId })).rejects.toBe(failure);
  });

  test("routes rule CAS operations and scoped global/project events", async () => {
    const fake = new FakeClient();
    const adapter: RuleStoreAdapter = createRuleStoreAdapter(fake as never);
    await adapter.list({ scope: "global", folder: null });
    await adapter.read({ scope: "global", folder: null, id: "RULES.md" });
    await adapter.write({
      scope: "project",
      folder,
      id: "RULES.md",
      content: "body",
      enabled: true,
      expectedRevision: "r1",
    });
    await adapter.delete({ scope: "project", folder, id: "RULES.md", expectedRevision: "r2" });
    expect(fake.calls).toEqual([
      ["rule.list", { scope: "global", folder: null }],
      ["rule.read", { scope: "global", folder: null, id: "RULES.md" }],
      [
        "rule.write",
        {
          scope: "project",
          folder,
          id: "RULES.md",
          content: "body",
          enabled: true,
          expectedRevision: "r1",
        },
      ],
      ["rule.delete", { scope: "project", folder, id: "RULES.md", expectedRevision: "r2" }],
    ]);

    const received: RuleChanged[] = [];
    const unsubscribe = adapter.subscribeChanged({ scope: "global", folder: null }, (change) =>
      received.push(change),
    );
    await Promise.resolve();
    const key = `${RuleStore.name}/changed/global`;
    fake.emit(key, {
      folder: null,
      scope: "global",
      id: "RULES.md",
      revision: "r3",
      reason: "filesystem",
    });
    expect(fake.subscriptions).toContain(key);
    expect(received).toHaveLength(1);
    unsubscribe();

    const projectUnsubscribe = adapter.subscribeChanged(
      { scope: "project", folder },
      () => undefined,
    );
    await Promise.resolve();
    expect(fake.subscriptions).toContain(`${RuleStore.name}/changed/folder:${folder}`);
    projectUnsubscribe();

    const failure = new AppFailure({ code: "conflict", message: "stale", retryable: false });
    fake.ruleFailure = failure;
    await expect(
      adapter.write({
        scope: "project",
        folder,
        id: "RULES.md",
        content: "body",
        enabled: true,
        expectedRevision: "r1",
      }),
    ).rejects.toBe(failure);
  });
});
