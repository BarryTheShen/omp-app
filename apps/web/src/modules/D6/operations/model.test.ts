import { describe, expect, test } from "vitest";
import { fixtureAgent, fixtureClock, fixtureRosterStore } from "@/modules/P1/fixtures/common";
import { RECORDED_PROGRESS } from "@/modules/P1/fixtures/roster";
import { formatDuration } from "@/modules/P1/panels/model";
import type { AgentRosterStoreSnapshot, RosterAgent } from "@/modules/P1/roster";
import {
  BTW_STATUS_LABEL,
  btwModelOf,
  cleanseModelOf,
  omfgModelOf,
  panelStateOf,
  pauseModelOf,
} from "./model";

function rosterWithRecordedWorker(): AgentRosterStoreSnapshot {
  const store = fixtureRosterStore(fixtureClock(1_000));
  store.mergeSnapshot([
    fixtureAgent("LongProbe", 0, {
      description: "Repository checker",
      progress: RECORDED_PROGRESS,
    }),
  ]);
  return store.getSnapshot();
}

function rosterWithReusedId(): AgentRosterStoreSnapshot {
  const roster = rosterWithRecordedWorker();
  const key = roster.order[0];
  const original = key === undefined ? undefined : roster.agents[key];
  if (original === undefined) throw new Error("The recorded roster worker is missing.");
  const oldKey = `${original.id}:0` as RosterAgent["key"];
  const latestKey = `${original.id}:1` as RosterAgent["key"];
  const old: RosterAgent = {
    ...original,
    key: oldKey,
    incarnation: 0,
    status: "completed",
    terminalAt: 2_000,
  };
  const latest: RosterAgent = {
    ...original,
    key: latestKey,
    incarnation: 1,
    status: "running",
    terminalAt: null,
  };
  return {
    ...roster,
    agents: { [oldKey]: old, [latestKey]: latest },
    order: [oldKey, latestKey],
    active: [latestKey],
    recent: [oldKey],
  };
}

describe("D6 operational models", () => {
  test("uses P1 duration formatting for short and long elapsed time", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(61_000)).toBe("1 min 1 s");
    expect(formatDuration(7_505_000)).toBe("2 h 5 min");
  });

  test("keeps side questions separate and selects the newest answer by default", () => {
    const model = btwModelOf({
      turns: [
        { id: "one", question: "What is one?", answer: "One", status: "complete" },
        { id: "two", question: "What is two?", answer: "", status: "running" },
      ],
      copy: { state: "available" },
      cancel: { state: "available" },
      branch: {
        state: "unavailable",
        reason: "Opening a side question in chat is not available here.",
      },
    });
    expect(model.selectedId).toBe("two");
    expect(model.lifecycle).toBe("updating");
    expect(model.turns).toHaveLength(2);
    expect(model.branch).toEqual({
      state: "unavailable",
      reason: "Opening a side question in chat is not available here.",
    });
    expect(BTW_STATUS_LABEL).toEqual({
      running: "Running",
      complete: "Done",
      cancelled: "Cancelled",
      error: "Failed",
      interrupted: "Interrupted",
    });
  });

  test("reads cleanse step, duration and status from P1's recorded progress record", () => {
    const roster = rosterWithRecordedWorker();
    const workerKey = roster.order[0];
    const worker = workerKey === undefined ? undefined : roster.agents[workerKey];
    if (worker === undefined) throw new Error("The recorded roster worker is missing.");
    const model = cleanseModelOf({
      status: "running",
      wave: 2,
      totalWaves: 3,
      checker: "repository",
      progress: 0.4,
      agentIds: [worker.id],
      roster,
      check: { state: "available" },
      run: { state: "available" },
      cancel: { state: "available" },
    });
    expect(model.lifecycle).toBe("updating");
    expect(model.progress).toBe(0.4);
    expect(model.agents[0]).toMatchObject({
      title: "Repository checker",
      status: "Running",
      step: "Using bash",
      duration: "0 s",
    });
    expect(model.agents[0]).not.toHaveProperty("progress");
  });

  test("a reused P1 worker id resolves to the newest incarnation", () => {
    const roster = rosterWithReusedId();
    const key = roster.order[0];
    const original = key === undefined ? undefined : roster.agents[key];
    if (original === undefined) throw new Error("The recorded roster worker is missing.");
    const model = cleanseModelOf({ status: "running", agentIds: [original.id], roster });
    expect(model.agents[0]?.status).toBe("Running");
  });

  test("maps unknown cleanse state and action fallbacks to scoped messages", () => {
    const model = cleanseModelOf({
      status: "unknown",
      agentIds: [],
      message: "The cleanse status has not been confirmed.",
    });
    expect(model.lifecycle).toBe("unavailable");
    expect(model.error?.message).toBe("The cleanse status has not been confirmed.");
    expect(model.check).toEqual({
      state: "unavailable",
      reason: "This action is not available in this omp session.",
    });
  });

  test("keeps omfg preview state and save actions explicit", () => {
    const model = omfgModelOf({
      status: "preview",
      complaint: "The same mistake happened twice.",
      candidate: "Always check the result.",
      validation: ["Preview only; nothing has been saved."],
      save: { state: "available" },
      amend: { state: "available" },
      cancel: { state: "available" },
    });
    expect(model.lifecycle).toBe("populated");
    expect(model.candidate).toContain("Always check");
    expect(model.validation).toEqual(["Preview only; nothing has been saved."]);
  });

  test("maps the D6 local pause snapshot without claiming authority", () => {
    const snapshot = {
      open: true,
      openedAt: 1_000,
      elapsedMs: 61_000,
      authoritative: false as const,
      reason: "Paused locally while you review the work.",
    };
    const model = pauseModelOf({ snapshot, resume: { state: "available" } });
    const state = panelStateOf(model, true);
    expect(model.snapshot).toEqual(snapshot);
    expect(state.lifecycle).toBe("populated");
    expect(model.resume).toEqual({ state: "available" });
  });
});
