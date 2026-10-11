import { SessionFilePath, SubagentId, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { SubagentClient } from "@/modules/P1/client";
import { type AgentRef, AgentRefSchema, type P1SubagentEvent } from "@/modules/P1/contract";
import { AgentRosterStore } from "../store";

const threadId = ThreadId.parse("thread-roster");
const TTL = 24 * 60 * 60 * 1000;

function agent(id: string, index: number, sessionFile = `/workspace/${id}.jsonl`): AgentRef {
  return AgentRefSchema.parse({
    id: SubagentId.parse(id),
    index,
    agent: `worker-${id}`,
    agentSource: "project",
    status: "running",
    lastUpdate: 1_759_600_000_000 + index,
    task: `task-${id}`,
    progress: { phase: "working" },
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
        progress: { percent: 80, model: "model", usage: { tokens: 5 } },
      },
    };
    now += 1;
    store.ingestNotification(progress, 1);
    const after = store.getSnapshot();
    expect(after.agents[aKey]).toBe(before.agents[aKey]);
    expect(after.agents[bKey]).not.toBe(before.agents[bKey]);
    expect(after.agents[bKey]?.metrics.percent).toBe(80);
    expect(after.agents[bKey]?.task).toBe("new task");
  });

  test("a worker the roster held as running reads as ended from the moment omp says it is not running", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const key = requireValue(store.getSnapshot().active[0]);
    now += 5;
    expect(store.markNotRunning(SubagentId.parse("a"))).toBe(true);
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

  test("a snapshot that still lists a worker as running cannot revive it, and an unknown worker is not marked", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const key = requireValue(store.getSnapshot().active[0]);
    store.markNotRunning(SubagentId.parse("a"));
    now += 1;
    store.mergeSnapshot([agent("a", 0)]);
    expect(store.getSnapshot().agents[key]?.status).toBe("completed");
    expect(store.markNotRunning(SubagentId.parse("missing"))).toBe(false);
  });

  test("a failed end after the roster was told omp no longer runs the worker ends it as Failed, and keeps its first end time", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const key = requireValue(store.getSnapshot().active[0]);
    now += 5;
    store.markNotRunning(SubagentId.parse("a"));
    now += 60_000;
    const failed = lifecycle("a", "failed", 0, 1);
    store.ingestNotification(failed.event, failed.seq);
    expect(store.getSnapshot().agents[key]).toMatchObject({ status: "failed", terminalAt: 1_005 });
  });

  test("a new run started after the roster was told omp no longer runs the worker is a new row, and the ended row stays ended", () => {
    let now = 1_000;
    const store = new AgentRosterStore({
      threadId,
      client: fakeClient(),
      clock: { now: () => now },
    });
    store.mergeSnapshot([agent("a", 0)]);
    const oldKey = requireValue(store.getSnapshot().active[0]);
    now += 5;
    store.markNotRunning(SubagentId.parse("a"));
    now += 60_000;
    const started = lifecycle("a", "started", 0, 1);
    store.ingestNotification(started.event, started.seq);
    const snapshot = store.getSnapshot();
    expect(snapshot.agents[oldKey]).toMatchObject({ status: "completed", terminalAt: 1_005 });
    expect(snapshot.active).toHaveLength(1);
    expect(snapshot.active[0]).not.toBe(oldKey);
  });
});
