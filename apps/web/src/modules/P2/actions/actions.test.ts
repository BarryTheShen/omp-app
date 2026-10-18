import { type PlanDocument, type PlanDocumentInput, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { PlanStateController } from "../contract";
import {
  createPlanActionController,
  type PlanActionResult,
  planActionAvailability,
} from "./actions";

const threadId = ThreadId.parse("plan-thread");
const document = {
  id: "plan-1",
  threadId,
  markdown: "# Plan",
  sections: [{ id: "plan", heading: "Plan", start: 0, end: 6 }],
  annotations: [],
  status: "review" as const,
};
const savedDocument: PlanDocument = {
  ...document,
  revision: 1,
  updatedAt: "2026-10-18T00:00:00.000Z",
};

function fakePlan(overrides: Partial<PlanStateController> = {}): PlanStateController {
  return {
    getSnapshot: () => ({
      threadId,
      document: savedDocument,
      revisions: [],
      mode: "review",
      authority: "host",
      pendingAction: null,
      isDirty: false,
      selectedSectionId: null,
      toc: savedDocument.sections,
      conflict: null,
      error: null,
    }),
    save: async (_input: PlanDocumentInput) => ({
      ...fakePlan().getSnapshot(),
      document: savedDocument,
    }),
    ...overrides,
  } as PlanStateController;
}

describe("plan action authority", () => {
  test("exposes host refine and gates authoritative actions without upstream plan mode", () => {
    const availability = planActionAvailability({
      state: "unavailable",
      via: "upstream",
      detail: "This omp has no plan-mode RPC.",
    });
    expect(availability).toEqual([
      {
        action: "approve",
        authority: "upstream",
        enabled: false,
        reason: "This omp has no plan-mode RPC.",
      },
      { action: "refine", authority: "host", enabled: true, reason: null },
      {
        action: "execute",
        authority: "upstream",
        enabled: false,
        reason: "This omp has no plan-mode RPC.",
      },
      {
        action: "cancel",
        authority: "upstream",
        enabled: false,
        reason: "This omp has no plan-mode RPC.",
      },
    ]);
  });

  test("refine saves the host document and never calls a prompt fallback", async () => {
    let saves = 0;
    const controller = createPlanActionController({
      plan: fakePlan({
        save: async () => {
          saves += 1;
          return fakePlan().getSnapshot();
        },
      }),
    });
    await expect(controller.refine(document)).resolves.toMatchObject({
      action: "refine",
      authority: "host",
      status: "refined",
    });
    expect(saves).toBe(1);
    await expect(controller.approve()).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "upstream.plan-mode" },
    });
  });

  test("calls the typed upstream seam for approve, execute and cancel", async () => {
    const calls: string[] = [];
    const result = (
      action: PlanActionResult["action"],
      status: PlanActionResult["status"],
    ): PlanActionResult => ({
      action,
      status,
      authority: "upstream",
      document: savedDocument,
    });
    const controller = createPlanActionController({
      plan: fakePlan(),
      upstreamCapability: { state: "available", via: "upstream" },
      upstream: {
        approve: async (id) => {
          calls.push(`approve:${id}`);
          return result("approve", "approved");
        },
        execute: async (id) => {
          calls.push(`execute:${id}`);
          return result("execute", "executed");
        },
        cancel: async (id) => {
          calls.push(`cancel:${id}`);
          return result("cancel", "cancelled");
        },
      },
    });

    await controller.approve();
    await controller.execute();
    await controller.cancel();
    expect(calls).toEqual(["approve:plan-thread", "execute:plan-thread", "cancel:plan-thread"]);
  });
  test("rejects each mismatched upstream response with a retryable conflict", async () => {
    const mismatches: readonly PlanActionResult[] = [
      { action: "execute", authority: "upstream", status: "approved", document: savedDocument },
      { action: "approve", authority: "host", status: "approved", document: savedDocument },
      { action: "approve", authority: "upstream", status: "executed", document: savedDocument },
    ];
    for (const mismatch of mismatches) {
      const controller = createPlanActionController({
        plan: fakePlan(),
        upstreamCapability: { state: "available", via: "upstream" },
        upstream: {
          approve: async () => mismatch,
          execute: async () => mismatch,
          cancel: async () => mismatch,
        },
      });
      await expect(controller.approve()).rejects.toMatchObject({
        appError: {
          code: "conflict",
          retryable: true,
          message: "The plan action response did not match the requested action.",
        },
      });
    }
  });

  test("requires upstream authority even when the capability is otherwise available", async () => {
    let upstreamCalls = 0;
    const controller = createPlanActionController({
      plan: fakePlan(),
      upstreamCapability: { state: "available", via: "rpc" },
      upstream: {
        approve: async () => {
          upstreamCalls += 1;
          return {
            action: "approve",
            authority: "upstream",
            status: "approved",
            document: savedDocument,
          };
        },
        execute: async () => {
          upstreamCalls += 1;
          return {
            action: "execute",
            authority: "upstream",
            status: "executed",
            document: savedDocument,
          };
        },
        cancel: async () => {
          upstreamCalls += 1;
          return {
            action: "cancel",
            authority: "upstream",
            status: "cancelled",
            document: savedDocument,
          };
        },
      },
    });
    expect(controller.availability()).toEqual([
      {
        action: "approve",
        authority: "upstream",
        enabled: false,
        reason:
          "omp does not provide authoritative plan actions here yet. Save or refine the host plan, then use plan controls in omp's terminal.",
      },
      { action: "refine", authority: "host", enabled: true, reason: null },
      {
        action: "execute",
        authority: "upstream",
        enabled: false,
        reason:
          "omp does not provide authoritative plan actions here yet. Save or refine the host plan, then use plan controls in omp's terminal.",
      },
      {
        action: "cancel",
        authority: "upstream",
        enabled: false,
        reason:
          "omp does not provide authoritative plan actions here yet. Save or refine the host plan, then use plan controls in omp's terminal.",
      },
    ]);
    await expect(controller.approve()).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "upstream.plan-mode" },
    });
    expect(upstreamCalls).toBe(0);
  });

  test("enables every authoritative action only through upstream", () => {
    expect(planActionAvailability({ state: "available", via: "upstream" })).toEqual([
      { action: "approve", authority: "upstream", enabled: true, reason: null },
      { action: "refine", authority: "host", enabled: true, reason: null },
      { action: "execute", authority: "upstream", enabled: true, reason: null },
      { action: "cancel", authority: "upstream", enabled: true, reason: null },
    ]);
  });

  test("rejects authoritative actions without a saved plan before calling upstream", async () => {
    let upstreamCalls = 0;
    const controller = createPlanActionController({
      plan: fakePlan({
        getSnapshot: () => ({ ...fakePlan().getSnapshot(), document: null, mode: "off" }),
      }),
      upstreamCapability: { state: "available", via: "upstream" },
      upstream: {
        approve: async () => {
          upstreamCalls += 1;
          return {
            action: "approve",
            authority: "upstream",
            status: "approved",
            document: null,
          };
        },
        execute: async () => {
          upstreamCalls += 1;
          return {
            action: "execute",
            authority: "upstream",
            status: "executed",
            document: null,
          };
        },
        cancel: async () => {
          upstreamCalls += 1;
          return {
            action: "cancel",
            authority: "upstream",
            status: "cancelled",
            document: null,
          };
        },
      },
    });
    await expect(controller.execute()).rejects.toMatchObject({
      appError: {
        code: "invalid_args",
        message: "Create and save a plan before using plan review actions.",
      },
    });
    expect(upstreamCalls).toBe(0);
  });

  test("returns the saved document from host refinement", async () => {
    await expect(
      createPlanActionController({ plan: fakePlan() }).refine(document),
    ).resolves.toMatchObject({
      action: "refine",
      authority: "host",
      status: "refined",
      document: savedDocument,
    });
  });

  test("passes one abort signal to the store and every upstream action", async () => {
    const signal = new AbortController().signal;
    let storeSignal: AbortSignal | undefined;
    const upstreamSignals: AbortSignal[] = [];
    const controller = createPlanActionController({
      plan: fakePlan({
        save: async (_document, options) => {
          storeSignal = options?.signal;
          return fakePlan().getSnapshot();
        },
      }),
      upstreamCapability: { state: "available", via: "upstream" },
      upstream: {
        approve: async (_id, options) => {
          upstreamSignals.push(options?.signal as AbortSignal);
          return {
            action: "approve",
            authority: "upstream",
            status: "approved",
            document: savedDocument,
          };
        },
        execute: async (_id, options) => {
          upstreamSignals.push(options?.signal as AbortSignal);
          return {
            action: "execute",
            authority: "upstream",
            status: "executed",
            document: savedDocument,
          };
        },
        cancel: async (_id, options) => {
          upstreamSignals.push(options?.signal as AbortSignal);
          return {
            action: "cancel",
            authority: "upstream",
            status: "cancelled",
            document: savedDocument,
          };
        },
      },
    });
    await controller.refine(document, { signal });
    await controller.approve({ signal });
    await controller.execute({ signal });
    await controller.cancel({ signal });
    expect(storeSignal).toBe(signal);
    expect(upstreamSignals).toEqual([signal, signal, signal]);
  });
});
