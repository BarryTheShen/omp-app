import type { PlanChanged, PlanDocument, PlanDocumentInput } from "@omp-app/contracts";
import { AppFailure, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  createPlanDocumentStoreAdapter,
  type PlanDocumentStoreSource,
  PlanStateController,
} from "./plan";

const threadId = ThreadId.parse("p2-plan-thread");
const input: PlanDocumentInput = {
  id: "plan-p2",
  threadId,
  markdown: "# Plan\n",
  sections: [{ id: "section-plan", heading: "Plan", start: 0, end: 1 }],
  annotations: [],
  status: "draft",
};
const document: PlanDocument = { ...input, revision: 1, updatedAt: "2026-10-05T00:00:00.000Z" };

function source(): {
  source: PlanDocumentStoreSource;
  saveCalls: Array<{ document: PlanDocumentInput; expectedRevision: number }>;
  publish: (next: PlanDocument) => void;
} {
  let current: PlanDocument | null = document;
  const listeners = new Set<(change: PlanChanged) => void>();
  const saveCalls: Array<{ document: PlanDocumentInput; expectedRevision: number }> = [];
  return {
    saveCalls,
    publish: (next) => {
      current = next;
      for (const listener of listeners) listener({ threadId, document: next, revisions: [] });
    },
    source: {
      load: async () => ({ document: current, revisions: [] }),
      save: async (next, expectedRevision) => {
        saveCalls.push({ document: next, expectedRevision });
        const saved = {
          ...next,
          revision: expectedRevision + 1,
          updatedAt: "2026-10-05T00:00:01.000Z",
        };
        current = saved;
        return { document: saved, revisions: [] };
      },
      export: async (documentId, format) => ({
        documentId,
        format,
        text: format === "markdown" ? (current?.markdown ?? "") : "{}",
      }),
      subscribeChanged: (_thread, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

describe("P2 PlanStateController", () => {
  test("loads, saves through CAS, and projects sections into TOC", async () => {
    const fake = source();
    const controller = new PlanStateController({ store: fake.source, threadId });
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({
      mode: "planning",
      toc: [{ id: "section-plan" }],
    });
    await controller.save({ ...input, markdown: "# Updated\n" });
    expect(fake.saveCalls[0]).toMatchObject({ expectedRevision: 1 });
    expect(controller.getSnapshot()).toMatchObject({ isDirty: false, document: { revision: 2 } });
    controller.dispose();
  });

  test("re-reads on conflict and never retries the stale write", async () => {
    const fake = source();
    let saves = 0;
    const conflictSource: PlanDocumentStoreSource = {
      ...fake.source,
      save: async () => {
        saves += 1;
        throw new AppFailure({ code: "conflict", message: "stale revision", retryable: true });
      },
      load: async () => ({
        document: { ...document, revision: 3, markdown: "# Remote\n" },
        revisions: [],
      }),
    };
    const controller = new PlanStateController({ store: conflictSource, threadId });
    await controller.load();
    await expect(controller.save(input)).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(saves).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      isDirty: true,
      conflict: { revision: 3 },
      document: { revision: 3 },
    });
  });

  test("applies only the subscribed thread's changed event", async () => {
    const fake = source();
    const controller = new PlanStateController({ store: fake.source, threadId });
    await controller.load();
    const listener = vi.fn();
    controller.subscribe(listener);
    fake.publish({ ...document, revision: 2, markdown: "# Changed\n" });
    expect(listener).toHaveBeenCalled();
    expect(controller.getSnapshot().document?.markdown).toBe("# Changed\n");
  });
});

describe("createPlanDocumentStoreAdapter", () => {
  test("uses A1.20 port methods and scopes changed subscription by thread", async () => {
    const subscriptions: unknown[] = [];
    const calls: unknown[] = [];
    const fakeClient = {
      port: () => ({
        load: async (args: unknown) => {
          calls.push(["load", args]);
          return { document: null, revisions: [] };
        },
        save: async (args: unknown) => {
          calls.push(["save", args]);
          return { document: null, revisions: [] };
        },
        export: async (args: unknown) => {
          calls.push(["export", args]);
          return { documentId: "p", format: "markdown", text: "" };
        },
      }),
      subscribe: async (_port: unknown, event: string, scope: unknown) => {
        subscriptions.push([event, scope]);
        return { onEvent: () => () => undefined, unsubscribe: async () => undefined };
      },
    };
    const adapter = createPlanDocumentStoreAdapter(fakeClient as never);
    await adapter.load(threadId);
    const unsubscribe = adapter.subscribeChanged(threadId, () => undefined);
    await Promise.resolve();
    unsubscribe();
    expect(calls).toContainEqual(["load", { threadId }]);
    expect(subscriptions).toContainEqual(["changed", { scope: String(threadId) }]);
  });
});
