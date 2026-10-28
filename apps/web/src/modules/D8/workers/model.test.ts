import {
  type CapabilityMap,
  SessionFilePath,
  SubagentId,
  ThreadId,
  ToolCallId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import { RECORDED_PROGRESS } from "@/modules/P1/fixtures";
import type { AgentRosterStoreSnapshot, RosterAgent } from "@/modules/P1/roster";
import { buildWorkersModel, formatElapsed, type WorkerRowModel } from "./model";

const threadId = ThreadId.parse("thread-workers");
const NOW = 1_000_000;

function workerAgent(patch: Partial<RosterAgent> & { readonly key: string }): RosterAgent {
  const id = patch.id ?? SubagentId.parse(patch.key.replace(/:\d+$/, ""));
  return {
    id,
    index: 0,
    agent: "task",
    agentSource: "bundled",
    status: "running",
    lastUpdate: NOW,
    threadId,
    incarnation: 1,
    terminalAt: null,
    lifecycleSeq: 1,
    progressSeq: null,
    metrics: { durationMs: 0, receivedAt: NOW, raw: {} },
    ...patch,
  };
}

function snapshotOf(
  agents: readonly RosterAgent[],
  active: readonly string[],
): AgentRosterStoreSnapshot {
  const recent = agents.map((agent) => agent.key).filter((key) => !active.includes(key));
  return {
    threadId,
    revision: 1,
    lastSeq: 1,
    agents: Object.fromEntries(agents.map((agent) => [agent.key, agent])),
    order: agents.map((agent) => agent.key),
    active,
    recent,
  };
}

const ALL_P1_AVAILABLE: CapabilityMap = {
  [P1CapabilityKeys.transcript]: { state: "available", via: "omp" },
  [P1CapabilityKeys.cancel]: { state: "available", via: "omp" },
};

function rowFor(rows: readonly WorkerRowModel[], key: string): WorkerRowModel {
  const row = rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`no row for ${key}`);
  return row;
}

describe("formatElapsed", () => {
  test("reads a duration in plain words with singular and plural units", () => {
    expect(formatElapsed(0)).toBe("0 seconds");
    expect(formatElapsed(1_000)).toBe("1 second");
    expect(formatElapsed(65_000)).toBe("1 minute 5 seconds");
    expect(formatElapsed(3_600_000 + 180_000)).toBe("1 hour 3 minutes");
  });
});

describe("buildWorkersModel", () => {
  test("lists active workers first, then recent ones, with plain status labels", () => {
    const running = workerAgent({
      key: "run-1:1",
      id: SubagentId.parse("run-1"),
      status: "running",
    });
    const done = workerAgent({
      key: "done-1:1",
      id: SubagentId.parse("done-1"),
      status: "completed",
      terminalAt: NOW - 5,
    });
    const cancelled = workerAgent({
      key: "stop-1:1",
      id: SubagentId.parse("stop-1"),
      status: "aborted",
      terminalAt: NOW - 5,
    });
    const model = buildWorkersModel({
      snapshot: snapshotOf([done, cancelled, running], ["run-1:1"]),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
    });
    expect(model.rows.map((row) => row.key)).toEqual(["run-1:1", "done-1:1", "stop-1:1"]);
    expect(model.activeCount).toBe(1);
    expect(model.rows.map((row) => row.status.label)).toEqual(["Running", "Finished", "Cancelled"]);
  });

  test("moves a running worker's time on from omp's last report, and freezes a finished one", () => {
    const running = workerAgent({
      key: "clock-1:1",
      id: SubagentId.parse("clock-1"),
      metrics: { durationMs: 60_000, receivedAt: NOW - 30_000, raw: {} },
    });
    const finished = workerAgent({
      key: "clock-2:1",
      id: SubagentId.parse("clock-2"),
      status: "completed",
      terminalAt: NOW - 1,
      metrics: { durationMs: 60_000, receivedAt: NOW - 30_000, raw: {} },
    });
    const model = buildWorkersModel({
      snapshot: snapshotOf([running, finished], ["clock-1:1"]),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
    });
    expect(rowFor(model.rows, "clock-1:1").elapsed).toBe("1 minute 30 seconds");
    expect(rowFor(model.rows, "clock-2:1").elapsed).toBe("1 minute");
  });

  test("uses a model override string or the recorded override list, never the worker role", () => {
    const stringOverride = workerAgent({
      key: "override-string:1",
      id: SubagentId.parse("override-string"),
      metrics: {
        durationMs: 0,
        receivedAt: NOW,
        raw: { modelOverride: " openai/test-model ", modelRole: "task" },
      },
    });
    const recordedOverride = workerAgent({
      key: "override-recorded:1",
      id: SubagentId.parse("override-recorded"),
      metrics: {
        durationMs: 0,
        receivedAt: NOW,
        raw: { ...RECORDED_PROGRESS, resolvedModel: undefined, modelRole: "task" },
      },
    });
    const model = buildWorkersModel({
      snapshot: snapshotOf(
        [stringOverride, recordedOverride],
        ["override-string:1", "override-recorded:1"],
      ),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
    });
    expect(rowFor(model.rows, "override-string:1").model).toBe("openai/test-model");
    expect(rowFor(model.rows, "override-recorded:1").model).toBe("fake/fake-model");
  });

  test("prefers the resolved model, truncates to 160 characters, and omits blank values", () => {
    const resolved = workerAgent({
      key: "resolved-model:1",
      id: SubagentId.parse("resolved-model"),
      metrics: {
        durationMs: 0,
        receivedAt: NOW,
        raw: {
          resolvedModel: " openai/resolved-model ",
          modelOverride: ["openai/override-model"],
          modelRole: "task",
        },
      },
    });
    const longModelValue = "m".repeat(200);
    const longModel = workerAgent({
      key: "long-model:1",
      id: SubagentId.parse("long-model"),
      metrics: { durationMs: 0, receivedAt: NOW, raw: { resolvedModel: longModelValue } },
    });
    const blank = workerAgent({
      key: "blank-model:1",
      id: SubagentId.parse("blank-model"),
      metrics: {
        durationMs: 0,
        receivedAt: NOW,
        raw: { resolvedModel: " ", modelOverride: " ", modelRole: "task" },
      },
    });
    const model = buildWorkersModel({
      snapshot: snapshotOf(
        [resolved, longModel, blank],
        ["resolved-model:1", "long-model:1", "blank-model:1"],
      ),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
    });

    expect(rowFor(model.rows, "resolved-model:1").model).toBe("openai/resolved-model");
    expect(rowFor(model.rows, "long-model:1").model).toBe(`${"m".repeat(159)}…`);
    expect(rowFor(model.rows, "blank-model:1").model).toBeNull();
  });

  test("takes the first non-blank entry of omp's override list, and none from an empty or blank list", () => {
    const skipsBlank = workerAgent({
      key: "list-blank-first:1",
      id: SubagentId.parse("list-blank-first"),
      metrics: {
        durationMs: 0,
        receivedAt: NOW,
        raw: { modelOverride: ["  ", "openai/second"], modelRole: "task" },
      },
    });
    const empty = workerAgent({
      key: "list-empty:1",
      id: SubagentId.parse("list-empty"),
      metrics: { durationMs: 0, receivedAt: NOW, raw: { modelOverride: [], modelRole: "task" } },
    });
    const allBlank = workerAgent({
      key: "list-all-blank:1",
      id: SubagentId.parse("list-all-blank"),
      metrics: {
        durationMs: 0,
        receivedAt: NOW,
        raw: { modelOverride: [" ", ""], modelRole: "task" },
      },
    });
    const model = buildWorkersModel({
      snapshot: snapshotOf(
        [skipsBlank, empty, allBlank],
        ["list-blank-first:1", "list-empty:1", "list-all-blank:1"],
      ),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
    });

    expect(rowFor(model.rows, "list-blank-first:1").model).toBe("openai/second");
    expect(rowFor(model.rows, "list-empty:1").model).toBeNull();
    expect(rowFor(model.rows, "list-all-blank:1").model).toBeNull();
  });

  test("shows the tokens and cost omp reported, and nothing when omp reported neither", () => {
    const withUsage = workerAgent({
      key: "use-1:1",
      id: SubagentId.parse("use-1"),
      metrics: { durationMs: 1_000, receivedAt: NOW, raw: { tokens: 1234, cost: 0.0421 } },
    });
    const without = workerAgent({ key: "use-2:1", id: SubagentId.parse("use-2") });
    const model = buildWorkersModel({
      snapshot: snapshotOf([withUsage, without], ["use-1:1", "use-2:1"]),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
    });
    expect(rowFor(model.rows, "use-1:1").usage).toBe("1,234 tokens · Cost $0.0421");
    expect(rowFor(model.rows, "use-2:1").usage).toBeNull();
  });

  test("gates transcript on its capability, and offers no stop without one or for an ended worker", () => {
    const running = workerAgent({
      key: "gate-1:1",
      id: SubagentId.parse("gate-1"),
      sessionFile: SessionFilePath.parse("/sessions/chat.jsonl"),
    });
    const ended = workerAgent({
      key: "gate-2:1",
      id: SubagentId.parse("gate-2"),
      status: "completed",
      terminalAt: NOW - 1,
    });
    const model = buildWorkersModel({
      snapshot: snapshotOf([running, ended], ["gate-1:1"]),
      now: NOW,
      capabilities: {},
    });
    const active = rowFor(model.rows, "gate-1:1");
    expect(active.transcript).toEqual({
      state: "unavailable",
      reason: "Reading worker transcripts is not available in this connection.",
      capability: P1CapabilityKeys.transcript,
    });
    expect(active.stop).toEqual({ state: "hidden" });
    expect(rowFor(model.rows, "gate-2:1").stop).toEqual({ state: "hidden" });
  });

  test("offers a stop only for a running worker when omp can cancel, and a transcript once omp saved one", () => {
    const running = workerAgent({
      key: "ok-1:1",
      id: SubagentId.parse("ok-1"),
      sessionFile: SessionFilePath.parse("/sessions/chat.jsonl"),
    });
    const model = buildWorkersModel({
      snapshot: snapshotOf([running], ["ok-1:1"]),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
    });
    expect(rowFor(model.rows, "ok-1:1").stop).toEqual({ state: "available" });
    expect(rowFor(model.rows, "ok-1:1").transcript).toEqual({ state: "available" });
  });

  test("offers no stop for a queued worker, though omp can cancel", () => {
    const queued = workerAgent({ key: "q-1:1", id: SubagentId.parse("q-1"), status: "pending" });
    const model = buildWorkersModel({
      snapshot: snapshotOf([queued], ["q-1:1"]),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
    });
    expect(rowFor(model.rows, "q-1:1").status.label).toBe("Queued");
    expect(rowFor(model.rows, "q-1:1").stop).toEqual({ state: "hidden" });
  });

  test("reads a stop in flight as stopping, so its row offers no second stop", () => {
    const running = workerAgent({ key: "s-1:1", id: SubagentId.parse("s-1") });
    const model = buildWorkersModel({
      snapshot: snapshotOf([running], ["s-1:1"]),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
      stopping: new Set(["s-1"]),
    });
    expect(rowFor(model.rows, "s-1:1").stop).toEqual({ state: "stopping" });
  });

  test("says a worker started from this chat only when omp names the tool call that started it", () => {
    const named = workerAgent({
      key: "l-1:1",
      id: SubagentId.parse("l-1"),
      parentToolCallId: ToolCallId.parse("call-7"),
    });
    const unnamed = workerAgent({ key: "l-2:1", id: SubagentId.parse("l-2") });
    const model = buildWorkersModel({
      snapshot: snapshotOf([named, unnamed], ["l-1:1", "l-2:1"]),
      now: NOW,
      capabilities: {},
    });
    expect(rowFor(model.rows, "l-1:1").lineage).toBe("Started from this chat");
    expect(rowFor(model.rows, "l-2:1").lineage).toBeNull();
  });
});

describe("the workers panel reports only what omp sends", () => {
  test("shows the model omp reports for a worker, the way CC8 asks for agent transparency", () => {
    const worker = workerAgent({
      key: "w-1:1",
      id: SubagentId.parse("w-1"),
      metrics: {
        durationMs: 0,
        receivedAt: NOW,
        raw: { resolvedModel: "fake/fake-model:high" },
      },
    });
    const model = buildWorkersModel({
      snapshot: snapshotOf([worker], ["w-1:1"]),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
    });
    expect(rowFor(model.rows, "w-1:1").model).toBe("fake/fake-model:high");
  });
});

describe("a worker shows its progress", () => {
  test("a running worker shows the step it is on and its tool calls; an ended one shows no step", () => {
    const running = workerAgent({
      key: "p-1:1",
      id: SubagentId.parse("p-1"),
      metrics: { durationMs: 0, receivedAt: NOW, raw: { currentTool: "bash", toolCount: 7 } },
    });
    const ended = workerAgent({
      key: "p-2:1",
      id: SubagentId.parse("p-2"),
      status: "completed",
      terminalAt: NOW - 1,
      metrics: { durationMs: 0, receivedAt: NOW, raw: { currentTool: "bash", toolCount: 3 } },
    });
    const model = buildWorkersModel({
      snapshot: snapshotOf([running, ended], ["p-1:1"]),
      now: NOW,
      capabilities: ALL_P1_AVAILABLE,
    });
    expect(rowFor(model.rows, "p-1:1")).toMatchObject({
      step: "Using bash",
      toolCalls: "7 tool calls",
    });
    expect(rowFor(model.rows, "p-2:1")).toMatchObject({ step: null, toolCalls: "3 tool calls" });
  });
});
