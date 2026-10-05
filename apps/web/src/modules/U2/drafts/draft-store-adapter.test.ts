import type { AppClient } from "@omp-app/client";
import type { Draft, DraftChanged, DraftScope, Revision } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createDraftStoreAdapter } from "./drafts";

const scope: DraftScope = { kind: "thread", threadId: "adapter-thread" as never };
const draft: Draft = {
  scope,
  text: "draft",
  attachments: [],
  failedSends: [],
  revision: "r1" as Revision,
  updatedAt: new Date(1).toISOString(),
};

class FakeClient {
  readonly calls: unknown[] = [];
  readonly scopes: string[] = [];
  private readonly listeners = new Map<string, Set<(payload: DraftChanged) => void>>();

  port() {
    return {
      get: async (args: unknown) => {
        this.calls.push(["get", args]);
        return { draft: null };
      },
      save: async (args: unknown) => {
        this.calls.push(["save", args]);
        return draft;
      },
      clear: async (args: unknown) => {
        this.calls.push(["clear", args]);
        return { cleared: true, revision: null };
      },
    };
  }

  async subscribe(_port: unknown, _event: unknown, options: { readonly scope?: string }) {
    const scopeKey = options.scope ?? "";
    this.scopes.push(scopeKey);
    const listeners = this.listeners.get(scopeKey) ?? new Set();
    this.listeners.set(scopeKey, listeners);
    return {
      stream: `A1.draftStore/changed/${scopeKey}`,
      lastSeq: 0,
      onEvent: (listener: (payload: DraftChanged, seq: number) => void) => {
        const wrapped = (payload: DraftChanged) => listener(payload, 1);
        listeners.add(wrapped);
        return () => listeners.delete(wrapped);
      },
      unsubscribe: async () => {
        this.listeners.delete(scopeKey);
      },
    };
  }

  emit(scopeKey: string, payload: DraftChanged): void {
    for (const listener of this.listeners.get(scopeKey) ?? []) listener(payload);
  }
}

describe("createDraftStoreAdapter", () => {
  test("routes get/save/clear through the typed DraftStore port", async () => {
    const fake = new FakeClient();
    const adapter = createDraftStoreAdapter(fake as unknown as AppClient);
    await adapter.get({ scope });
    await adapter.save({
      scope,
      draft: { text: "x", attachments: [], failedSends: [] },
      expectedRevision: null,
    });
    await adapter.clear({ scope, expectedRevision: null });
    expect(fake.calls).toEqual([
      ["get", { scope }],
      [
        "save",
        { scope, draft: { text: "x", attachments: [], failedSends: [] }, expectedRevision: null },
      ],
      ["clear", { scope, expectedRevision: null }],
    ]);
  });

  test("subscribes to the matching scoped stream and stops after unsubscribe", async () => {
    const fake = new FakeClient();
    const adapter = createDraftStoreAdapter(fake as unknown as AppClient);
    const received: DraftChanged[] = [];
    const unsubscribe = adapter.subscribeChanged?.(scope, (change) => received.push(change));
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.scopes).toEqual(["thread:adapter-thread"]);
    fake.emit("folder:other", { scope, draft });
    fake.emit("thread:adapter-thread", { scope, draft });
    expect(received).toEqual([{ scope, draft }]);
    unsubscribe?.();
    fake.emit("thread:adapter-thread", { scope, draft: null });
    expect(received).toHaveLength(1);
  });
});
