import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { P1ClientNotification, SubagentClient } from "@/modules/P1/client";
import type { P1SubagentEvent } from "@/modules/P1/contract";
import { createFocusedAgentRuntime } from "../source";
import {
  agentRef,
  firstFile,
  lifecycleEvent,
  nestedFrame,
  threadId,
  transcriptPage,
} from "./fixtures";

interface Recorded {
  readonly reads: Array<{ readonly id: string; readonly options: unknown }>;
  readonly steers: Array<{ readonly id: string; readonly message: string }>;
  readonly cancels: string[];
  readonly levels: string[];
  released: number;
  unsubscribed: number;
}

function fakeClient(options: { readonly acquireFails?: AppFailure } = {}) {
  const recorded: Recorded = {
    reads: [],
    steers: [],
    cancels: [],
    levels: [],
    released: 0,
    unsubscribed: 0,
  };
  let deliver: ((notification: P1ClientNotification) => void) | undefined;
  const client: SubagentClient = {
    getRoster: async () => [],
    readTranscript: async (subagentId, readOptions) => {
      recorded.reads.push({ id: subagentId, options: readOptions });
      const fromByte = readOptions?.fromByte ?? 0;
      return transcriptPage({ fromByte, nextByte: fromByte });
    },
    cancel: async (subagentId) => {
      recorded.cancels.push(subagentId);
      return { cancelled: true };
    },
    steer: async (subagentId, message) => {
      recorded.steers.push({ id: subagentId, message });
    },
    setSubscriptionLevel: async (level) => level,
    acquireSubscription: async (level) => {
      if (options.acquireFails !== undefined) throw options.acquireFails;
      recorded.levels.push(level);
      return {
        level,
        release: async () => {
          recorded.released += 1;
        },
      };
    },
    subscribeNotifications: (listener) => {
      deliver = listener;
      return () => {
        recorded.unsubscribed += 1;
        deliver = undefined;
      };
    },
    dispose: async () => {},
  };
  return {
    client,
    recorded,
    send: (notification: P1ClientNotification) => deliver?.(notification),
  };
}

/** Lets the lease promise and its follow-up run. */
async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("the nested transcript source", () => {
  test("reads the worker's recorded file from the byte offset it asks for", async () => {
    const { client, recorded } = fakeClient();
    const source = createFocusedAgentRuntime({ agent: agentRef(), client });
    await source.read({ fromByte: 40 });
    expect(recorded.reads).toEqual([
      { id: "worker-1", options: { sessionFile: firstFile, fromByte: 40 } },
    ]);
  });

  test("delivers only the frames about this worker, with the thread and the sequence number", () => {
    const { client, send } = fakeClient();
    const source = createFocusedAgentRuntime({ agent: agentRef(), client });
    const seen: unknown[] = [];
    source.subscribe((event) => seen.push(event));
    send({ seq: 7, event: nestedFrame("worker-1") });
    send({ seq: 8, event: nestedFrame("worker-2") });
    send({ seq: 9, event: lifecycleEvent("completed") });
    send({
      seq: 10,
      event: {
        type: "subagent_progress",
        payload: { index: 3, agent: "task", agentSource: "bundled", task: "other", progress: {} },
      } as P1SubagentEvent,
    });
    expect(seen).toEqual([
      { threadId, seq: 7, event: nestedFrame("worker-1") },
      { threadId, seq: 9, event: lifecycleEvent("completed") },
    ]);
  });

  test("takes the events level while a listener is attached, and gives it back when the last one leaves", async () => {
    const { client, recorded } = fakeClient();
    const source = createFocusedAgentRuntime({ agent: agentRef(), client });
    const stop = source.subscribe(() => {});
    await flush();
    expect(recorded.levels).toEqual(["events"]);
    stop();
    await flush();
    expect(recorded.released).toBe(1);
    expect(recorded.unsubscribed).toBe(1);
  });

  test("reports a failure to set the events level to the caller that asked for live frames", async () => {
    const failure = new AppFailure({ code: "omp_error", message: "refused", retryable: true });
    const { client } = fakeClient({ acquireFails: failure });
    const source = createFocusedAgentRuntime({ agent: agentRef(), client });
    const reported: AppFailure[] = [];
    source.subscribe(
      () => {},
      (received) => reported.push(received),
    );
    await flush();
    expect(reported).toEqual([failure]);
  });
});

describe("the focused runtime", () => {
  test("steers a running worker through the client", async () => {
    const { client, recorded } = fakeClient();
    const runtime = createFocusedAgentRuntime({ agent: agentRef(), client });
    await runtime.steer("Drop the glob.");
    expect(recorded.steers).toEqual([{ id: "worker-1", message: "Drop the glob." }]);
  });

  test("cancels a running worker through the client", async () => {
    const { client, recorded } = fakeClient();
    const runtime = createFocusedAgentRuntime({ agent: agentRef(), client });
    await expect(runtime.cancel()).resolves.toEqual({ cancelled: true });
    expect(recorded.cancels).toEqual(["worker-1"]);
  });

  test("refuses to steer or cancel a worker that has finished, and never calls the client", async () => {
    const { client, recorded } = fakeClient();
    const runtime = createFocusedAgentRuntime({
      agent: agentRef({ status: "completed" }),
      client,
    });
    await expect(runtime.steer("too late")).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
    await expect(runtime.cancel()).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(recorded.steers).toEqual([]);
    expect(recorded.cancels).toEqual([]);
  });
});

/** A client whose cancel omp refuses the way it answers `cancelled: false`: the client reports a retryable conflict. */
function refusingClient(): SubagentClient {
  const { client } = fakeClient();
  return {
    ...client,
    cancel: async () => {
      throw new AppFailure({
        code: "conflict",
        message: "omp did not stop the worker",
        retryable: true,
      });
    },
  };
}

/** The roster as the nested card reads it: `endedAt` is when the re-read lists the worker as finished, if it does. */
function rosterThat(options: { readonly endedAt?: number; readonly refreshFails?: boolean } = {}) {
  let terminalAt: number | null = null;
  return {
    refresh: async (): Promise<void> => {
      if (options.refreshFails === true) {
        throw new AppFailure({
          code: "unavailable",
          message: "The roster could not be read.",
          retryable: true,
        });
      }
      terminalAt = options.endedAt ?? null;
    },
    getSnapshot: () => ({ agents: { "worker-1:1": { id: "worker-1", terminalAt } } }),
  };
}

describe("the nested transcript source: a refused cancel is worded after the roster is read again", () => {
  test("a worker omp has ended reads as not running, not as one that is still running", async () => {
    const runtime = createFocusedAgentRuntime({
      agent: agentRef(),
      client: refusingClient(),
      roster: rosterThat({ endedAt: 1_759_600_100_000 }),
      rosterKey: "worker-1:1",
    });
    await expect(runtime.cancel()).rejects.toMatchObject({ appError: { code: "not_found" } });
  });

  test("a refused cancel stays a refusal while the roster still lists the worker as running", async () => {
    const runtime = createFocusedAgentRuntime({
      agent: agentRef(),
      client: refusingClient(),
      roster: rosterThat(),
      rosterKey: "worker-1:1",
    });
    await expect(runtime.cancel()).rejects.toMatchObject({ appError: { code: "conflict" } });
  });

  test("a refused cancel stays a refusal when the roster cannot be read again", async () => {
    const runtime = createFocusedAgentRuntime({
      agent: agentRef(),
      client: refusingClient(),
      roster: rosterThat({ endedAt: 1_759_600_100_000, refreshFails: true }),
      rosterKey: "worker-1:1",
    });
    await expect(runtime.cancel()).rejects.toMatchObject({ appError: { code: "conflict" } });
  });

  test("without a roster, a refused cancel is passed on as omp answered it", async () => {
    const runtime = createFocusedAgentRuntime({ agent: agentRef(), client: refusingClient() });
    await expect(runtime.cancel()).rejects.toMatchObject({ appError: { code: "conflict" } });
  });

  test("with a roster but no key for the worker, a refused cancel is passed on as omp answered it", async () => {
    const runtime = createFocusedAgentRuntime({
      agent: agentRef(),
      client: refusingClient(),
      roster: rosterThat({ endedAt: 1_759_600_100_000 }),
    });
    await expect(runtime.cancel()).rejects.toMatchObject({ appError: { code: "conflict" } });
  });

  test("a refused cancel reads the worker's own roster entry, not an earlier worker that reused its id", async () => {
    const runtime = createFocusedAgentRuntime({
      agent: agentRef(),
      client: refusingClient(),
      roster: {
        refresh: async () => undefined,
        getSnapshot: () => ({
          agents: {
            "worker-1:1": { id: "worker-1", terminalAt: 1_759_600_100_000 },
            "worker-1:2": { id: "worker-1", terminalAt: null },
          },
        }),
      },
      rosterKey: "worker-1:2",
    });
    await expect(runtime.cancel()).rejects.toMatchObject({ appError: { code: "conflict" } });
  });
});
