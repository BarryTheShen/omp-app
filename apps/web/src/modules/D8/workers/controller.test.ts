import { AppFailure, type CapabilityMap, SubagentId, ThreadId } from "@omp-app/contracts";
import { describe, expect, type Mock, test, vi } from "vitest";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import type { AgentRosterStoreSnapshot, RosterAgent } from "@/modules/P1/roster";
import { createWorkersController, type WorkersController, type WorkersRoster } from "./controller";

const threadId = ThreadId.parse("thread-controller");
const NOW = 2_000_000;
const STOP_AVAILABLE: CapabilityMap = {
  [P1CapabilityKeys.cancel]: { state: "available", via: "omp" },
};

function runningAgent(id: string): RosterAgent {
  return {
    id: SubagentId.parse(id),
    index: 0,
    agent: "tan",
    agentSource: "bundled",
    status: "running",
    lastUpdate: NOW,
    threadId,
    key: `${id}:1`,
    incarnation: 1,
    terminalAt: null,
    lifecycleSeq: 1,
    progressSeq: null,
    metrics: { durationMs: 1_000, receivedAt: NOW, raw: {} },
  };
}

function endedAgent(id: string): RosterAgent {
  return { ...runningAgent(id), status: "completed", terminalAt: NOW - 1 };
}

function snapshotWith(agents: readonly RosterAgent[]): AgentRosterStoreSnapshot {
  return {
    threadId,
    revision: 1,
    lastSeq: 1,
    agents: Object.fromEntries(agents.map((agent) => [agent.key, agent])),
    order: agents.map((agent) => agent.key),
    active: agents.map((agent) => agent.key),
    recent: [],
  };
}

/** What a test drives: the roster it hands the controller, the calls the controller makes, and a push the store would make. */
interface FakeRoster {
  readonly roster: WorkersRoster;
  readonly start: Mock;
  readonly refresh: Mock;
  push(next: AgentRosterStoreSnapshot): void;
  listenerCount(): number;
}

/** A roster that records its listeners so a test can push a change the way the real store does. */
function fakeRoster(initial: AgentRosterStoreSnapshot): FakeRoster {
  let current = initial;
  const listeners = new Set<(snapshot: AgentRosterStoreSnapshot) => void>();
  const start = vi.fn(async (): Promise<void> => undefined);
  const refresh = vi.fn(async (): Promise<void> => undefined);
  const roster: WorkersRoster = {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    now: () => NOW,
  };
  return {
    roster,
    start,
    refresh,
    push(next) {
      current = next;
      for (const listener of listeners) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

function controllerWith(
  fake: FakeRoster,
  cancel: Mock,
  capabilities: CapabilityMap = {},
  debugLog: Mock = vi.fn(),
): WorkersController {
  return createWorkersController({
    roster: fake.roster,
    start: fake.start,
    client: { cancel },
    capabilities: () => capabilities,
    debugLog,
  });
}

describe("createWorkersController", () => {
  test("reads the roster once, and reports loading until the first read finishes", async () => {
    const fake = fakeRoster(snapshotWith([]));
    const controller = controllerWith(fake, vi.fn());
    expect(controller.getSnapshot().loading).toBe(true);
    controller.start();
    controller.start();
    expect(fake.start).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(controller.getSnapshot().loading).toBe(false));
    expect(controller.getSnapshot().error).toBeNull();
    controller.dispose();
  });

  test("reads the roster through the app's start, which shares a start already under way", async () => {
    const fake = fakeRoster(snapshotWith([]));
    const start = vi.fn(async (): Promise<void> => undefined);
    const controller = createWorkersController({
      roster: fake.roster,
      start,
      client: { cancel: vi.fn() },
      capabilities: () => ({}),
      debugLog: vi.fn(),
    });
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().loading).toBe(false));
    expect(start).toHaveBeenCalledTimes(1);
    expect(fake.refresh).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("keeps the same snapshot object until the roster changes, so a re-render reads no new model", async () => {
    const fake = fakeRoster(snapshotWith([runningAgent("a-1")]));
    const controller = controllerWith(fake, vi.fn());
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().loading).toBe(false));
    const first = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(first);
    const seen = vi.fn();
    controller.subscribe(seen);
    fake.push(snapshotWith([runningAgent("a-1"), runningAgent("b-1")]));
    expect(seen).toHaveBeenCalled();
    expect(controller.getSnapshot()).not.toBe(first);
    expect(controller.getSnapshot().model.rows).toHaveLength(2);
    controller.dispose();
  });

  test("asks omp to stop the worker, reads the roster again, and clears a previous error when the stop succeeds", async () => {
    const fake = fakeRoster(snapshotWith([runningAgent("c-1")]));
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error("omp refused the first stop"))
      .mockResolvedValueOnce({ cancelled: true });
    const debugLog = vi.fn();
    const controller = controllerWith(fake, cancel, STOP_AVAILABLE, debugLog);
    await controller.stop("c-1");
    expect(cancel).toHaveBeenCalledWith(SubagentId.parse("c-1"));
    expect(controller.getSnapshot().error).toBe("The worker could not be stopped. Try again.");
    expect(debugLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: "omp refused the first stop" }),
    );
    await controller.stop("c-1");
    expect(controller.getSnapshot().error).toBeNull();
    expect(fake.refresh).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  test("shows a plain sentence for a stop omp cannot make, never the capability id, and keeps the cause in the debug log", async () => {
    const fake = fakeRoster(snapshotWith([runningAgent("d-1")]));
    const refusal = new AppFailure({
      code: "unavailable",
      message: "Capability omp.cmd.cancel_subagent is unavailable",
      retryable: false,
      capability: P1CapabilityKeys.cancel,
    });
    const debugLog = vi.fn();
    const controller = controllerWith(fake, vi.fn().mockRejectedValue(refusal), {}, debugLog);
    await controller.stop("d-1");
    expect(controller.getSnapshot().error).toBe(
      "Cancelling workers isn't available in this version of omp.",
    );
    expect(controller.getSnapshot().error).not.toContain("omp.cmd.cancel_subagent");
    expect(debugLog).toHaveBeenCalledWith(refusal);
    controller.dismissError();
    expect(controller.getSnapshot().error).toBeNull();
    controller.dispose();
  });

  test("a second click on a worker whose stop is in flight does nothing, and the row reads Stopping until the stop ends", async () => {
    const fake = fakeRoster(snapshotWith([runningAgent("e-1")]));
    const answer = Promise.withResolvers<void>();
    const cancel = vi.fn(() => answer.promise);
    const controller = controllerWith(fake, cancel, STOP_AVAILABLE);
    const first = controller.stop("e-1");
    expect(controller.getSnapshot().model.rows[0]?.stop.state).toBe("stopping");
    await controller.stop("e-1");
    expect(cancel).toHaveBeenCalledTimes(1);
    answer.resolve();
    await first;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().model.rows[0]?.stop.state).toBe("available");
    controller.dispose();
  });

  test("a stop omp refuses on a worker that has since ended reads the roster again and shows no error", async () => {
    const fake = fakeRoster(snapshotWith([runningAgent("f-1")]));
    const conflict = new AppFailure({ code: "conflict", message: "omp refused", retryable: false });
    fake.refresh.mockImplementationOnce(async (): Promise<void> => {
      fake.push(snapshotWith([endedAgent("f-1")]));
    });
    const controller = controllerWith(fake, vi.fn().mockRejectedValue(conflict), STOP_AVAILABLE);
    await controller.stop("f-1");
    expect(fake.refresh).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().error).toBeNull();
    controller.dispose();
  });

  test("a stop omp refuses on a worker that is still running reads the roster again and says it could not stop now", async () => {
    const fake = fakeRoster(snapshotWith([runningAgent("g-1")]));
    const conflict = new AppFailure({ code: "conflict", message: "omp refused", retryable: false });
    const controller = controllerWith(fake, vi.fn().mockRejectedValue(conflict), STOP_AVAILABLE);
    await controller.stop("g-1");
    expect(fake.refresh).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().error).toBe(
      "omp could not stop this worker now, because it is still running. Try Stop again.",
    );
    controller.dispose();
  });

  test("does nothing on stop after dispose, and releases its roster listener", async () => {
    const fake = fakeRoster(snapshotWith([]));
    const cancel = vi.fn();
    const controller = controllerWith(fake, cancel);
    controller.start();
    await vi.waitFor(() => expect(controller.getSnapshot().loading).toBe(false));
    expect(fake.listenerCount()).toBe(1);
    controller.dispose();
    expect(fake.listenerCount()).toBe(0);
    await controller.stop("never");
    expect(cancel).not.toHaveBeenCalled();
  });

  test("a stop that fails after the panel closed is not reported: the close cancelled it", async () => {
    const fake = fakeRoster(snapshotWith([runningAgent("h-1")]));
    const answer = Promise.withResolvers<void>();
    const debugLog = vi.fn();
    const controller = controllerWith(
      fake,
      vi.fn(() => answer.promise),
      STOP_AVAILABLE,
      debugLog,
    );
    const stopping = controller.stop("h-1");
    // The panel closes while the stop is in flight; closing the app's connection then fails the call.
    controller.dispose();
    answer.reject(
      new AppFailure({ code: "unavailable", message: "Client disposed", retryable: false }),
    );
    await stopping;
    expect(debugLog).not.toHaveBeenCalled();
  });

  test("a roster read that fails after the panel closed is not reported", async () => {
    const fake = fakeRoster(snapshotWith([]));
    const read = Promise.withResolvers<void>();
    fake.start.mockImplementationOnce(() => read.promise);
    const debugLog = vi.fn();
    const controller = controllerWith(fake, vi.fn(), {}, debugLog);
    controller.start();
    controller.dispose();
    read.reject(
      new AppFailure({ code: "unavailable", message: "Client disposed", retryable: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(debugLog).not.toHaveBeenCalled();
  });

  test("reads the roster again on retry after a failed read, and shows a plain sentence until then", async () => {
    const fake = fakeRoster(snapshotWith([]));
    fake.start.mockRejectedValueOnce(new Error("The app connection dropped"));
    const debugLog = vi.fn();
    const controller = controllerWith(fake, vi.fn(), {}, debugLog);
    controller.start();
    await vi.waitFor(() =>
      expect(controller.getSnapshot().error).toBe("The workers could not be read. Try again."),
    );
    expect(debugLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The app connection dropped" }),
    );
    expect(controller.getSnapshot().loading).toBe(false);
    controller.retry();
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBeNull());
    expect(fake.start).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
