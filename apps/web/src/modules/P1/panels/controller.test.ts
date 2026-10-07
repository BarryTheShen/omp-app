import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { AgentRef } from "@/modules/P1/contract";
import { type AgentHubActions, createAgentHubController } from "./controller";
import {
  FIXTURE_NOW,
  fixtureClock,
  fixtureRoster,
  fixtureWorker,
  lifecycleEvent,
} from "./fixtures";

const NO_TRANSCRIPT = {
  state: "unavailable",
  reason: "The transcript view is not open here.",
} as const;

function actions(run: (agent: AgentRef) => Promise<unknown>): () => AgentHubActions {
  const value: AgentHubActions = {
    cancel: { state: "available", run },
    openTranscript: NO_TRANSCRIPT,
  };
  return () => value;
}

function keyOf(order: readonly string[], id: string): string {
  const key = order.find((candidate) => candidate.startsWith(`${id}:`));
  if (key === undefined) throw new Error(`no worker ${id} in the fixture`);
  return key;
}

describe("AgentHub controller cancel", () => {
  test("one cancel call per worker: duplicates are ignored while it is sent and after it is accepted", async () => {
    const store = await fixtureRoster({
      clock: fixtureClock(),
      workers: [fixtureWorker("runner", 1)],
    });
    const key = keyOf(store.getSnapshot().order, "runner");
    const run = vi.fn(async () => ({ cancelled: true }));
    const controller = createAgentHubController({ roster: store, actions: actions(run) });

    const first = controller.cancel(key);
    expect(controller.getState().cancels[key]).toEqual({ state: "sending" });
    await controller.cancel(key);
    await first;
    expect(run).toHaveBeenCalledTimes(1);
    expect(controller.getState().cancels[key]).toEqual({ state: "sent" });
    await controller.cancel(key);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("a failed cancel keeps omp's own reason and can be retried", async () => {
    const store = await fixtureRoster({
      clock: fixtureClock(),
      workers: [fixtureWorker("stubborn", 1)],
    });
    const key = keyOf(store.getSnapshot().order, "stubborn");
    const run = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(
        new AppFailure({
          code: "not_found",
          message: "Subagent is no longer running",
          retryable: false,
        }),
      )
      .mockResolvedValueOnce({ cancelled: true });
    const controller = createAgentHubController({ roster: store, actions: actions(run) });

    await controller.cancel(key);
    expect(controller.getState().cancels[key]).toMatchObject({
      state: "failed",
      error: { code: "not_found", message: "Subagent is no longer running", retryable: false },
    });
    await controller.cancel(key);
    expect(run).toHaveBeenCalledTimes(2);
    expect(controller.getState().cancels[key]).toEqual({ state: "sent" });
  });

  test("a failure that is not an AppFailure becomes a retryable message, never a thrown error", async () => {
    const store = await fixtureRoster({
      clock: fixtureClock(),
      workers: [fixtureWorker("broken", 1)],
    });
    const key = keyOf(store.getSnapshot().order, "broken");
    const controller = createAgentHubController({
      roster: store,
      actions: actions(async () => {
        throw new Error("socket closed");
      }),
    });
    await expect(controller.cancel(key)).resolves.toBeUndefined();
    expect(controller.getState().cancels[key]).toEqual({
      state: "failed",
      error: {
        code: "internal",
        message: "The worker could not be cancelled. Try again.",
        retryable: true,
      },
    });
  });

  test("queued, finished and unavailable workers are never sent a cancel", async () => {
    const clock = fixtureClock();
    const store = await fixtureRoster({
      clock,
      workers: [fixtureWorker("queued", 1, { status: "pending" }), fixtureWorker("done", 2)],
      events: [{ at: FIXTURE_NOW + 10, seq: 1, event: lifecycleEvent("done", 2, "completed") }],
    });
    const order = store.getSnapshot().order;
    const run = vi.fn(async () => ({ cancelled: true }));
    const controller = createAgentHubController({ roster: store, actions: actions(run) });
    await controller.cancel(keyOf(order, "queued"));
    await controller.cancel(keyOf(order, "done"));
    expect(run).not.toHaveBeenCalled();

    const blocked = createAgentHubController({
      roster: store,
      actions: () => ({
        cancel: { state: "unavailable", reason: "This omp cannot cancel workers." },
        openTranscript: NO_TRANSCRIPT,
      }),
    });
    await blocked.cancel(keyOf(order, "queued"));
    expect(blocked.getState().cancels).toEqual({});
  });

  test("a cancel that the worker outlives is dropped once the worker is no longer running", async () => {
    const clock = fixtureClock();
    const store = await fixtureRoster({ clock, workers: [fixtureWorker("quick", 1)] });
    const key = keyOf(store.getSnapshot().order, "quick");
    const controller = createAgentHubController({
      roster: store,
      actions: actions(async () => ({ cancelled: true })),
    });
    const subscription = controller.subscribe(() => {});
    await controller.cancel(key);
    expect(controller.getState().cancels[key]).toEqual({ state: "sent" });
    clock.set(FIXTURE_NOW + 50);
    store.ingestNotification(lifecycleEvent("quick", 1, "aborted"), 1);
    expect(controller.getState().cancels).toEqual({});
    subscription();
  });
});

describe("AgentHub controller selection and passive updates", () => {
  test("a passive progress update keeps the reader's selection and view", async () => {
    const store = await fixtureRoster({
      clock: fixtureClock(),
      workers: [fixtureWorker("one", 1), fixtureWorker("two", 2)],
    });
    const order = store.getSnapshot().order;
    const controller = createAgentHubController({
      roster: store,
      actions: actions(async () => ({ cancelled: true })),
    });
    controller.select(keyOf(order, "two"));
    controller.setView("byParent");
    store.ingestNotification(
      {
        type: "subagent_progress",
        payload: {
          index: 1,
          agent: "task",
          agentSource: "bundled",
          task: "scan",
          progress: { toolCount: 4 },
        },
      },
      1,
    );
    expect(controller.getState().selectedKey).toBe(keyOf(store.getSnapshot().order, "two"));
    expect(controller.getState().view).toBe("byParent");
    expect(controller.getState().model.inspector?.key).toBe(keyOf(order, "two"));
  });

  test("the selection stays on a worker that finished, and clears when omp drops it from the roster", async () => {
    const clock = fixtureClock();
    const store = await fixtureRoster({
      clock,
      workers: [fixtureWorker("kept", 1), fixtureWorker("gone", 2)],
      events: [{ at: FIXTURE_NOW + 10, seq: 1, event: lifecycleEvent("gone", 2, "completed") }],
    });
    const order = store.getSnapshot().order;
    const controller = createAgentHubController({
      roster: store,
      actions: actions(async () => ({ cancelled: true })),
    });
    const goneKey = keyOf(order, "gone");
    controller.select(goneKey);
    expect(controller.getState().selectedKey).toBe(goneKey);
    clock.set(FIXTURE_NOW + 60 * 60 * 1000 * 25);
    store.ingestNotification(lifecycleEvent("kept", 1, "started"), 2);
    expect(controller.getState().selectedKey).toBeNull();
    expect(controller.getState().model.inspector).toBeNull();
  });

  test("the load state, the view and the selection each change the model", async () => {
    const store = await fixtureRoster({
      clock: fixtureClock(),
      workers: [fixtureWorker("only", 1)],
    });
    const controller = createAgentHubController({
      roster: store,
      actions: actions(async () => ({ cancelled: true })),
      initialLoad: { state: "loading" },
    });
    expect(controller.getState().model.lifecycle).toBe("loading");
    controller.setLoad({ state: "ready" });
    expect(controller.getState().model.lifecycle).toBe("populated");
    controller.setView("byParent");
    expect(controller.getState().model.view).toBe("byParent");
    controller.select(keyOf(store.getSnapshot().order, "only"));
    expect(controller.getState().model.inspector?.title).toBe("only");
  });
});

describe("AgentHub controller subscription", () => {
  test("state keeps its identity until something changes, and listeners stop after unsubscribe", async () => {
    const store = await fixtureRoster({
      clock: fixtureClock(),
      workers: [fixtureWorker("steady", 1)],
    });
    const controller = createAgentHubController({
      roster: store,
      actions: actions(async () => ({ cancelled: true })),
    });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    const first = controller.getState();
    expect(controller.getState()).toBe(first);
    controller.select(keyOf(store.getSnapshot().order, "steady"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getState()).not.toBe(first);
    unsubscribe();
    controller.setView("byParent");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("opening a transcript passes the worker to the composition's callback, and does nothing without one", async () => {
    const store = await fixtureRoster({
      clock: fixtureClock(),
      workers: [fixtureWorker("view", 1)],
    });
    const key = keyOf(store.getSnapshot().order, "view");
    const open = vi.fn();
    const controller = createAgentHubController({
      roster: store,
      actions: () => ({
        cancel: { state: "available", run: async () => ({ cancelled: true }) },
        openTranscript: { state: "available", open },
      }),
    });
    controller.openTranscript(key);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "view", status: "running" }));

    const blocked = createAgentHubController({
      roster: store,
      actions: actions(async () => ({ cancelled: true })),
    });
    expect(() => blocked.openTranscript(key)).not.toThrow();
  });
});
