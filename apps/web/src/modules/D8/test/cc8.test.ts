import { type CapabilityMap, CapabilityStatus, SessionFilePath } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { P1CapabilityKeys } from "@/modules/P1/contract";
import type { AgentRosterStoreSnapshot } from "@/modules/P1/roster";
import { continuationStatus } from "../contract";
import { D8_DESCRIPTORS } from "../descriptors";
import {
  CONTINUATION_MODE_SETTINGS,
  OMP_WORKER_CAPABILITIES,
  RECORDED_GOAL_CREATED,
  recordedWorkerRoster,
  WORKERS_NOW,
} from "../fixtures";
import { buildWorkersModel, type WorkerRowModel } from "../workers/model";

const NOW = WORKERS_NOW + 60_000;
const roster = recordedWorkerRoster();

function rowFor(id: string, capabilities: CapabilityMap = OMP_WORKER_CAPABILITIES): WorkerRowModel {
  const found = buildWorkersModel({ snapshot: roster, now: NOW, capabilities }).rows.find(
    (row) => row.id === id,
  );
  if (found === undefined) throw new Error(`no worker row for ${id}`);
  return found;
}

/** The recorded roster with a session file on one worker: the file a worker has once omp has saved its transcript. */
function rosterWithSessionFile(key: string): AgentRosterStoreSnapshot {
  const agent = roster.agents[key];
  if (agent === undefined) throw new Error(`no worker ${key}`);
  return {
    ...roster,
    agents: {
      ...roster.agents,
      [key]: {
        ...agent,
        sessionFile: SessionFilePath.parse("/workspace/sessions/scout-one.jsonl"),
      },
    },
  };
}

describe("CC8: the workers panel shows what omp reports and nothing more", () => {
  test("the panel lists each recorded worker once, active workers first", () => {
    const model = buildWorkersModel({
      snapshot: roster,
      now: NOW,
      capabilities: OMP_WORKER_CAPABILITIES,
    });
    expect(model.rows.map((row) => row.id)).toEqual([
      "ScoutOne",
      "ScoutTwo",
      "BuilderTwo",
      "ScoutThree",
    ]);
    expect(model.activeCount).toBe(3);
  });

  test("the model shows the roster's active and recent split", () => {
    expect(rowFor("ScoutOne").status.status).toBe("running");
    expect(rowFor("BuilderTwo").status.status).toBe("pending");
    const failed = rowFor("ScoutThree");
    expect(failed.status.status).toBe("failed");
    expect(failed.active).toBe(false);
    expect(failed.step).toBeNull();
    expect(failed.stop.state).toBe("hidden");
  });

  test("stop is offered only for a running worker, and only when omp can cancel", () => {
    const noCancel: CapabilityMap = {
      ...OMP_WORKER_CAPABILITIES,
      [P1CapabilityKeys.cancel]: CapabilityStatus.parse({ state: "unavailable", via: "omp" }),
    };
    expect(rowFor("ScoutOne").stop.state).toBe("available");
    expect(rowFor("ScoutTwo").stop.state).toBe("available");
    expect(rowFor("BuilderTwo").stop.state).toBe("hidden");
    expect(rowFor("ScoutOne", noCancel).stop.state).toBe("hidden");
  });

  test("without a session file in the roster the transcript control says so; with one it is available", () => {
    expect(rowFor("ScoutOne").transcript).toEqual({
      state: "unavailable",
      reason: "omp has not saved this worker's transcript yet.",
    });
    const withFile = buildWorkersModel({
      snapshot: rosterWithSessionFile("ScoutOne:0"),
      now: NOW,
      capabilities: OMP_WORKER_CAPABILITIES,
    }).rows.find((row) => row.id === "ScoutOne");
    expect(withFile?.transcript).toEqual({ state: "available" });
  });

  test("a missing transcript capability names the capability", () => {
    const noTranscripts: CapabilityMap = {
      ...OMP_WORKER_CAPABILITIES,
      [P1CapabilityKeys.transcript]: CapabilityStatus.parse({ state: "unavailable", via: "omp" }),
    };
    expect(rowFor("ScoutOne", noTranscripts).transcript).toMatchObject({
      state: "unavailable",
      capability: P1CapabilityKeys.transcript,
    });
  });

  test("usage shows what omp reported: BuilderTwo's recorded zeros, and nothing for a wait job", () => {
    expect(rowFor("BuilderTwo").usage).toBe("0 tokens · Cost $0.00");
    expect(rowFor("ScoutOne").usage).toBeNull();
  });

  test("a running wait job shows the model omp reported", () => {
    expect(rowFor("ScoutOne").model).toBe("openai-codex/gpt-5.6-luna:max");
  });

  test("a queued worker shows no elapsed time (#1694)", () => {
    expect(rowFor("BuilderTwo").elapsed).toBeNull();
  });

  test("a queued worker's model is not its role (#1694)", () => {
    expect(rowFor("BuilderTwo").model).toBeNull();
  });

  test("the tan and vibe descriptors need an upstream seam, not a released command", () => {
    for (const id of ["D8.tanCommand", "D8.vibeCommand", "D8.vibeStatus"]) {
      const descriptor = D8_DESCRIPTORS.find((item) => item.id === id);
      expect(descriptor?.requires.length).toBeGreaterThan(0);
      expect(descriptor?.requires.every((key) => key.startsWith("upstream."))).toBe(true);
    }
  });

  test("the goal's continuation names omp's setting when rpc is not in it", () => {
    expect(
      continuationStatus(RECORDED_GOAL_CREATED.value, CONTINUATION_MODE_SETTINGS.withoutRpc)?.label,
    ).toContain("Goal Continuation Modes in Settings, Tasks");
  });

  test("the continuation says the app cannot tell when it cannot read the setting", () => {
    expect(
      continuationStatus(RECORDED_GOAL_CREATED.value, CONTINUATION_MODE_SETTINGS.unreadable)?.label,
    ).toBe("The app cannot tell whether omp continues this goal by itself.");
  });
});
