import { SubagentId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { AgentRosterStoreSnapshot } from "@/modules/P1/roster";
import {
  FIXTURE_NOW,
  FIXTURE_THREAD_ID,
  fixtureClock,
  fixtureRoster,
  fixtureWorker,
} from "./fixtures";
import { buildHubModel, type HubModelInput } from "./model";

function inputFor(snapshot: AgentRosterStoreSnapshot, selectedKey: string): HubModelInput {
  return {
    roster: snapshot,
    load: { state: "ready" },
    view: "list",
    selectedKey,
    cancels: {},
    cancelAction: { state: "available" },
    transcriptAction: { state: "unavailable", reason: "The transcript view is not open here." },
  };
}

describe("a worker found in its file", () => {
  test("shows only the parts that are known: no unknown and no source not recorded", async () => {
    const roster = await fixtureRoster({ clock: fixtureClock(), workers: [] });
    roster.adoptFinished([
      {
        endedAt: FIXTURE_NOW - 60_000,
        agent: {
          id: SubagentId.parse("NestedProbe"),
          index: 0,
          agent: "",
          agentSource: "unknown",
          status: "completed",
          lastUpdate: FIXTURE_NOW - 60_000,
          threadId: FIXTURE_THREAD_ID,
        },
      },
    ]);
    const snapshot = roster.getSnapshot();
    const key = snapshot.order[0] ?? "";
    const model = buildHubModel(inputFor(snapshot, key));
    expect(model.inspector?.title).toBe("NestedProbe");
    expect(model.inspector?.subtitle).toBe("");
    expect(model.inspector?.facts.map((fact) => fact.label)).not.toContain("Type");
    const shown = JSON.stringify(model);
    expect(shown).not.toContain("unknown");
    expect(shown).not.toContain("source not recorded");
    await roster.dispose();
  });

  test("keeps the agent type a finished worker's file does record", async () => {
    const roster = await fixtureRoster({ clock: fixtureClock(), workers: [] });
    roster.adoptFinished([
      {
        endedAt: FIXTURE_NOW - 60_000,
        agent: {
          id: SubagentId.parse("NestedProbe"),
          index: 0,
          agent: "task",
          agentSource: "unknown",
          status: "completed",
          lastUpdate: FIXTURE_NOW - 60_000,
          threadId: FIXTURE_THREAD_ID,
        },
      },
    ]);
    const snapshot = roster.getSnapshot();
    const model = buildHubModel(inputFor(snapshot, snapshot.order[0] ?? ""));
    expect(model.inspector?.subtitle).toBe("task");
    expect(model.inspector?.facts).toContainEqual({ label: "Type", value: "task" });
    expect(JSON.stringify(model)).not.toContain("source not recorded");
    await roster.dispose();
  });
});

describe("a finished worker corrects the roster's record of it", () => {
  test("a worker the roster only saw as pending takes the transcript's end, and leaves the active list", async () => {
    const clock = fixtureClock();
    const roster = await fixtureRoster({
      clock,
      workers: [fixtureWorker("NestedProbe", 0, { status: "pending" })],
    });
    expect(roster.getSnapshot().active).toHaveLength(1);
    roster.adoptFinished([
      {
        endedAt: FIXTURE_NOW - 60_000,
        agent: {
          id: SubagentId.parse("NestedProbe"),
          index: 0,
          agent: "task",
          agentSource: "unknown",
          status: "completed",
          lastUpdate: FIXTURE_NOW - 60_000,
          threadId: FIXTURE_THREAD_ID,
        },
      },
    ]);
    const snapshot = roster.getSnapshot();
    expect(snapshot.active).toEqual([]);
    expect(snapshot.order).toHaveLength(1);
    expect(snapshot.agents[snapshot.order[0] ?? ""]).toMatchObject({
      status: "completed",
      terminalAt: FIXTURE_NOW - 60_000,
    });
    await roster.dispose();
  });

  test("the corrected record keeps what the roster knew of the worker: its task call, description, index and source", async () => {
    const roster = await fixtureRoster({
      clock: fixtureClock(),
      workers: [
        fixtureWorker("NestedProbe", 2, {
          status: "pending",
          parentToolCallId: "task-call",
          description: "Probe the nested task",
        }),
      ],
    });
    const before = roster.getSnapshot();
    const key = before.order[0] ?? "";
    roster.adoptFinished([
      {
        endedAt: FIXTURE_NOW - 60_000,
        agent: {
          id: SubagentId.parse("NestedProbe"),
          index: 0,
          agent: "task",
          agentSource: "unknown",
          status: "completed",
          lastUpdate: FIXTURE_NOW - 60_000,
          threadId: FIXTURE_THREAD_ID,
        },
      },
    ]);
    const after = roster.getSnapshot().agents[key];
    expect(after).toMatchObject({
      status: "completed",
      parentToolCallId: "task-call",
      description: "Probe the nested task",
      index: 2,
      agentSource: "bundled",
    });
    await roster.dispose();
  });
});
