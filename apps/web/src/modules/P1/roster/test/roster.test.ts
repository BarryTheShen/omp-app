import { SessionFilePath, SubagentId, ThreadId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { SubagentClient } from "@/modules/P1/client";
import { type AgentRef, AgentRefSchema, type P1SubagentEvent } from "@/modules/P1/contract";
import { AgentRosterStore } from "../store";

const threadId = ThreadId.parse("thread-roster");
const TTL = 24 * 60 * 60 * 1000;

/**
 * A progress record omp sent for a running worker: recorded from real omp 18.8.9, a worker running `sleep 60` in bash
 * (the fake model's `spawn_long_subagent` branch). Copied as omp sent it, so its keys and value types are omp's.
 */
const REAL_PROGRESS = {
  index: 0,
  id: "LongProbe",
  agent: "task",
  agentSource: "bundled",
  status: "running",
  task: "Complete assignment thoroughly:\n\nlong_probe_child: run one slow step.",
  assignment: "long_probe_child: run one slow step.",
  recentTools: [],
  recentOutput: [],
  toolCount: 1,
  requests: 1,
  tokens: 15,
  cost: 0,
  durationMs: 105,
  modelOverride: ["fake/fake-model"],
  contextWindow: 128000,
  resolvedModelIdentity: "fake/fake-model",
  resolvedThinkingLevel: "high",
  resolvedModel: "fake/fake-model:high",
  resolvedModelIsFallback: false,
  contextTokens: 15,
  currentTool: "bash",
  currentToolArgs: "sleep 60; echo long-probe-done",
  currentToolArgsKey: "command",
  currentToolStartMs: 1791731667364,
};

function agent(id: string, index: number, sessionFile = `/workspace/${id}.jsonl`): AgentRef {
  return AgentRefSchema.parse({
    id: SubagentId.parse(id),
    index,
    agent: `worker-${id}`,
    agentSource: "project",
    status: "running",
    lastUpdate: 1_759_600_000_000 + index,
    task: `task-${id}`,
    progress: REAL_PROGRESS,
    sessionFile,
    threadId,
  });
}

function fakeClient(roster: readonly AgentRef[] = []): SubagentClient {
  return {
    getRoster: async () => roster,
    readTranscript: async () => {
      throw new Error("unused");
    },
    cancel: async () => ({ cancelled: true as const }),
    steer: async () => {},
    setSubscriptionLevel: async (level) => level,
    acquireSubscription: async (level) => ({ level, release: async () => {} }),
    subscribeNotifications: () => () => {},
    dispose: async () => {},
  };
}

function lifecycle(
  id: string,
  status: "started" | "completed" | "failed" | "aborted",
  index: number,
  seq: number,
  sessionFile = `/workspace/${id}.jsonl`,
): { event: P1SubagentEvent; seq: number } {
  return {
    seq,
    event: {
      type: "subagent_lifecycle",
      payload: {
        id: SubagentId.parse(id),
        agent: `worker-${id}`,
        agentSource: "project",
        status,
        index,
        sessionFile: SessionFilePath.parse(sessionFile),
      },
    },
  };
}
function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a roster value");
  return value;
}

function completedAgent(id: string, index: number): AgentRef {
  return { ...agent(id, index), status: "completed" };
}

describe("P1 AgentRosterStore", () => {
  test("merges snapshots/lifecycle in sequence order and late snapshots cannot resurrect tombstones", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const activeKey = requireValue(store.getSnapshot().active[0]);
    const before = store.getSnapshot().agents[activeKey];

    now += 1;
    const done = lifecycle("a", "completed", 0, 1);
    store.ingestNotification(done.event, done.seq);
    expect(store.getSnapshot().agents[activeKey]?.status).toBe("completed");
    expect(store.getSnapshot().recent).toEqual([activeKey]);

    store.mergeSnapshot([agent("a", 0)]);
    expect(store.getSnapshot().agents[activeKey]?.status).toBe("completed");
    expect(store.getSnapshot().agents[activeKey]).not.toBe(before);
  });

  test("a worker that fails is read again from the chat's transcripts, so the roster learns why it failed", async () => {
    const reason = "400 fake provider failure (type=invalid_request_error)";
    let listed = 0;
    const finished = {
      list: async () => {
        listed += 1;
        return [{ agent: { ...agent("a", 0), status: "failed" as const, reason }, endedAt: 1_000 }];
      },
      read: async () => {
        throw new Error("unused");
      },
    };
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      finished,
      clock: { now: () => 1_000 },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const failed = lifecycle("a", "failed", 0, 1);
    store.ingestNotification(failed.event, failed.seq);
    await vi.waitFor(() => expect(listed).toBe(1));
    await vi.waitFor(() =>
      expect(Object.values(store.getSnapshot().agents).map((item) => item.reason)).toContain(
        reason,
      ),
    );
  });

  test("a reused id creates a new incarnation instead of resurrecting the old tombstone", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("reuse", 0, "/workspace/old.jsonl")]);
    const oldKey = requireValue(store.getSnapshot().active[0]);
    now += 1;
    const done = lifecycle("reuse", "completed", 0, 1, "/workspace/old.jsonl");
    store.ingestNotification(done.event, done.seq);
    now += 1;
    const started = lifecycle("reuse", "started", 1, 2, "/workspace/new.jsonl");
    store.ingestNotification(started.event, started.seq);

    expect(store.getSnapshot().recent).toContain(oldKey);
    expect(store.getSnapshot().active).toHaveLength(1);
    const activeKey = requireValue(store.getSnapshot().active[0]);
    expect(activeKey).not.toBe(oldKey);
    expect(store.getSnapshot().agents[activeKey]?.sessionFile).toBe("/workspace/new.jsonl");
  });

  test("expires tombstones by injectable clock and caps newest terminal records", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
      tombstoneTtlMs: TTL,
      tombstoneLimit: 2,
    });
    store.mergeSnapshot([agent("one", 0), agent("two", 1), agent("three", 2)]);
    for (const [index, id] of ["one", "two", "three"].entries()) {
      now += 1;
      const done = lifecycle(id, "completed", index, index + 1);
      store.ingestNotification(done.event, done.seq);
    }
    expect(store.getSnapshot().recent).toHaveLength(2);
    expect(store.getSnapshot().recent).not.toContain("one:0");

    now += TTL;
    const noop = lifecycle("three", "completed", 2, 4);
    store.ingestNotification(noop.event, noop.seq);
    expect(store.getSnapshot().recent).toEqual([]);
  });

  test("updates only the matched running agent from progress and structurally shares others", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0), agent("b", 1)]);
    const before = store.getSnapshot();
    const aKey = requireValue(before.active.find((key) => before.agents[key]?.id === "a"));
    const bKey = requireValue(before.active.find((key) => before.agents[key]?.id === "b"));
    const progress: P1SubagentEvent = {
      type: "subagent_progress",
      payload: {
        index: 1,
        agent: "worker-b",
        agentSource: "project",
        task: "new task",
        progress: REAL_PROGRESS,
      },
    };
    now += 1;
    store.ingestNotification(progress, 1);
    const after = store.getSnapshot();
    expect(after.agents[aKey]).toBe(before.agents[aKey]);
    expect(after.agents[bKey]).not.toBe(before.agents[bKey]);
    expect(after.agents[bKey]?.metrics.raw).toEqual(REAL_PROGRESS);
    expect(after.agents[bKey]?.metrics.durationMs).toBe(105);
    expect(after.agents[bKey]?.task).toBe("new task");
  });

  test("a progress frame keeps the worker's progress record current, the one a task card reads", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const key = requireValue(store.getSnapshot().active[0]);
    now += 1;
    const progress: P1SubagentEvent = {
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "worker-a",
        agentSource: "project",
        task: "task-a",
        progress: REAL_PROGRESS,
      },
    };
    store.ingestNotification(progress, 1);
    expect(store.getSnapshot().agents[key]?.progress).toEqual(REAL_PROGRESS);
  });

  test("a progress record's time is omp's durationMs: a field named duration is not read as one", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const key = requireValue(store.getSnapshot().active[0]);
    now += 1;
    const progress: P1SubagentEvent = {
      type: "subagent_progress",
      payload: {
        index: 0,
        agent: "worker-a",
        agentSource: "project",
        task: "task-a",
        progress: { duration: 5_000 },
      },
    };
    store.ingestNotification(progress, 1);
    expect(store.getSnapshot().agents[key]?.metrics.raw).toEqual({ duration: 5_000 });
    expect(store.getSnapshot().agents[key]?.metrics.durationMs).toBeUndefined();
  });

  test("the metrics hold omp's record and its time, and nothing read from a key omp does not send", () => {
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => 1_000 },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const snapshot = store.getSnapshot();
    const key = requireValue(snapshot.active[0]);
    expect(Object.keys(requireValue(snapshot.agents[key]).metrics).sort()).toEqual([
      "durationMs",
      "raw",
      "receivedAt",
    ]);
  });

  test("a worker a re-read lists as ended reads as ended from the moment the roster read it, and its time stays there", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const key = requireValue(store.getSnapshot().active[0]);
    now += 5;
    store.mergeSnapshot([completedAgent("a", 0)]);
    expect(store.getSnapshot().agents[key]).toMatchObject({
      status: "completed",
      terminalAt: 1_005,
    });
    expect(store.getSnapshot().recent).toEqual([key]);

    now += 60_000;
    const end = lifecycle("a", "completed", 0, 1);
    store.ingestNotification(end.event, end.seq);
    expect(store.getSnapshot().agents[key]).toMatchObject({
      status: "completed",
      terminalAt: 1_005,
    });
  });

  test("a snapshot that still lists an ended worker as running cannot revive it", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const key = requireValue(store.getSnapshot().active[0]);
    store.mergeSnapshot([completedAgent("a", 0)]);
    now += 1;
    store.mergeSnapshot([agent("a", 0)]);
    expect(store.getSnapshot().agents[key]?.status).toBe("completed");
  });

  test("a failed end after the roster read the worker as ended ends it as Failed, and keeps its first end time", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const key = requireValue(store.getSnapshot().active[0]);
    now += 5;
    store.mergeSnapshot([completedAgent("a", 0)]);
    now += 60_000;
    const failed = lifecycle("a", "failed", 0, 1);
    store.ingestNotification(failed.event, failed.seq);
    expect(store.getSnapshot().agents[key]).toMatchObject({ status: "failed", terminalAt: 1_005 });
  });

  test("a new run started after the roster read the worker as ended is a new row, and the ended row stays ended", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const oldKey = requireValue(store.getSnapshot().active[0]);
    now += 5;
    store.mergeSnapshot([completedAgent("a", 0)]);
    now += 60_000;
    const started = lifecycle("a", "started", 0, 1);
    store.ingestNotification(started.event, started.seq);
    const snapshot = store.getSnapshot();
    expect(snapshot.agents[oldKey]).toMatchObject({ status: "completed", terminalAt: 1_005 });
    expect(snapshot.active).toHaveLength(1);
    expect(snapshot.active[0]).not.toBe(oldKey);
  });
});
