import { type AppError, AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { AgentRosterStoreSnapshot } from "@/modules/P1/roster";
import {
  FIXTURE_NOW,
  fixtureClock,
  fixtureRoster,
  fixtureWorker,
  lifecycleEvent,
} from "./fixtures";
import {
  buildHubModel,
  cancelFailureMessage,
  formatClock,
  formatCost,
  formatDuration,
  type HubModelInput,
  readWorkerMetrics,
  statusPresentation,
} from "./model";

const AVAILABLE = { state: "available" } as const;
const NO_TRANSCRIPT = {
  state: "unavailable",
  reason: "The transcript view is not open here.",
} as const;

function input(
  roster: AgentRosterStoreSnapshot,
  patch: Partial<HubModelInput> = {},
): HubModelInput {
  return {
    roster,
    load: { state: "ready" },
    view: "list",
    selectedKey: null,
    cancels: {},
    cancelAction: AVAILABLE,
    transcriptAction: NO_TRANSCRIPT,
    ...patch,
  };
}

function keyOf(roster: AgentRosterStoreSnapshot, id: string): string {
  const key = roster.order.find((candidate) => candidate.startsWith(`${id}:`));
  if (key === undefined) throw new Error(`no worker ${id} in the fixture`);
  return key;
}

/** Five workers in every state: queued, running (with progress), finished, failed, cancelled. */
async function mixedRoster() {
  const clock = fixtureClock();
  const store = await fixtureRoster({
    clock,
    workers: [
      fixtureWorker("a", 1, {
        progress: { currentTool: "bash", toolCount: 2, durationMs: 5_000, modelRole: "fast" },
      }),
      fixtureWorker("b", 2, { status: "pending" }),
      fixtureWorker("c", 3),
      fixtureWorker("d", 4),
      fixtureWorker("e", 5),
    ],
    events: [
      { at: FIXTURE_NOW + 100, seq: 1, event: lifecycleEvent("c", 3, "completed") },
      { at: FIXTURE_NOW + 300, seq: 2, event: lifecycleEvent("d", 4, "failed") },
      { at: FIXTURE_NOW + 200, seq: 3, event: lifecycleEvent("e", 5, "aborted") },
    ],
  });
  return store.getSnapshot();
}

describe("statusPresentation", () => {
  test.each([
    ["pending", "Queued"],
    ["running", "Running"],
    ["completed", "Finished"],
    ["failed", "Failed"],
    ["aborted", "Cancelled"],
  ] as const)("omp status %s reads as %s", (status, label) => {
    expect(statusPresentation(status).label).toBe(label);
  });
});

describe("readWorkerMetrics", () => {
  test("reads only the typed progress fields and ignores every other key", () => {
    const metrics = readWorkerMetrics({
      currentTool: "bash",
      toolCount: 3.7,
      requests: -1,
      tokens: Number.NaN,
      cost: 0.0123,
      durationMs: 61_000,
      modelOverride: "  fake-model ",
      unknownField: { nested: true },
    });
    expect(metrics).toEqual({
      step: "Using bash",
      model: "fake-model",
      toolCalls: 3,
      requests: null,
      tokens: null,
      cost: 0.0123,
      durationMs: 61_000,
    });
  });

  test("cuts long text with an ellipsis and treats blank text as absent", () => {
    const long = readWorkerMetrics({ lastIntent: "x".repeat(400) });
    expect(long.step).toHaveLength(160);
    expect(long.step?.endsWith("…")).toBe(true);
    expect(readWorkerMetrics({ lastIntent: "   ", modelRole: "" }).step).toBeNull();
  });

  test("the model is the one omp resolved, then the override, then the role; a list override is ignored", () => {
    expect(
      readWorkerMetrics({
        resolvedModel: "anthropic/claude-x:high",
        modelOverride: "fast",
        modelRole: "fast",
      }).model,
    ).toBe("anthropic/claude-x:high");
    expect(readWorkerMetrics({ modelOverride: "fast", modelRole: "smol" }).model).toBe("fast");
    expect(readWorkerMetrics({ modelOverride: ["a", "b"], modelRole: "smol" }).model).toBe("smol");
    expect(readWorkerMetrics({ modelOverride: ["a"] }).model).toBeNull();
  });
});

describe("formatting", () => {
  test("durations cross from seconds to minutes to hours", () => {
    expect(formatDuration(900)).toBe("0 s");
    expect(formatDuration(59_999)).toBe("59 s");
    expect(formatDuration(61_000)).toBe("1 min 1 s");
    expect(formatDuration(3_660_000)).toBe("1 h 1 min");
  });

  test("cost is shown in dollars with up to four decimals", () => {
    expect(formatCost(0.0123)).toBe("$0.0123");
    expect(formatCost(2)).toBe("$2.00");
  });
});

describe("buildHubModel list view", () => {
  test("active workers come first by start order, recent ones newest first, with a count line", async () => {
    const roster = await mixedRoster();
    const model = buildHubModel(input(roster));
    expect(model.lifecycle).toBe("populated");
    expect(model.description).toBe("1 running · 1 queued · 3 recent");
    expect(model.sections.map((section) => section.heading)).toEqual(["Active", "Recent"]);
    const [active, recent] = model.sections;
    expect(active?.rows.map((row) => row.title)).toEqual(["a", "b"]);
    expect(active?.rows.map((row) => row.status.label)).toEqual(["Running", "Queued"]);
    expect(active?.rows[0]?.summary).toBe("Using bash · 5 s");
    expect(active?.rows[1]?.summary).toBe("Waiting to start");
    expect(recent?.rows.map((row) => row.status.label)).toEqual([
      "Failed",
      "Cancelled",
      "Finished",
    ]);
    expect(recent?.rows[0]?.summary).toBe(`Failed at ${formatClock(FIXTURE_NOW + 300)}`);
  });

  test("a worker's description is its title when omp gives one", async () => {
    const clock = fixtureClock();
    const store = await fixtureRoster({
      clock,
      workers: [fixtureWorker("named", 1, { description: "Scan the repo" })],
    });
    const model = buildHubModel(input(store.getSnapshot()));
    expect(model.sections[0]?.rows[0]?.title).toBe("Scan the repo");
  });

  test("the lifecycle follows the load outcome, and an empty roster is empty", async () => {
    const roster = await mixedRoster();
    expect(buildHubModel(input(roster, { load: { state: "loading" } })).lifecycle).toBe("loading");
    const failed: AppError = { code: "omp_error", message: "Roster unavailable", retryable: true };
    const errored = buildHubModel(input(roster, { load: { state: "error", error: failed } }));
    expect(errored.lifecycle).toBe("error");
    expect(errored.error).toEqual(failed);
    const unavailable = buildHubModel(
      input(roster, { load: { state: "unavailable", reason: "This omp has no subagent roster." } }),
    );
    expect(unavailable.error).toEqual({
      code: "unavailable",
      message: "This omp has no subagent roster.",
      retryable: false,
    });
    const empty = await fixtureRoster({ clock: fixtureClock(), workers: [] });
    const none = buildHubModel(input(empty.getSnapshot()));
    expect(none.lifecycle).toBe("empty");
    expect(none.sections).toEqual([]);
    expect(none.description).toBeNull();
  });
});

describe("buildHubModel by-parent view", () => {
  test("groups by the task call that started each worker, numbered in start order", async () => {
    const store = await fixtureRoster({
      clock: fixtureClock(),
      workers: [
        fixtureWorker("a", 1, { parentToolCallId: "call-one" }),
        fixtureWorker("b", 2, { parentToolCallId: "call-two" }),
        fixtureWorker("c", 3, { parentToolCallId: "call-one" }),
        fixtureWorker("d", 4),
      ],
    });
    const model = buildHubModel(input(store.getSnapshot(), { view: "byParent" }));
    expect(model.view).toBe("byParent");
    expect(model.sections.map((section) => section.heading)).toEqual([
      "From task call 1",
      "From task call 2",
      "Started from this chat",
    ]);
    expect(model.sections.map((section) => section.rows.length)).toEqual([2, 1, 1]);
  });
});

describe("buildHubModel inspector", () => {
  test("a running worker shows its facts, progress and a ready cancel control", async () => {
    const roster = await mixedRoster();
    const model = buildHubModel(input(roster, { selectedKey: keyOf(roster, "a") }));
    const inspector = model.inspector;
    expect(inspector?.title).toBe("a");
    expect(inspector?.subtitle).toBe("task · built in");
    expect(inspector?.step).toBe("Using bash");
    expect(inspector?.facts.map((fact) => fact.label)).toEqual([
      "Type",
      "Started from",
      "Last update",
    ]);
    expect(inspector?.facts[0]?.value).toBe("task (built in)");
    expect(inspector?.progress).toEqual([
      { label: "Model", value: "fast" },
      { label: "Tool calls", value: "2" },
      { label: "Running time", value: "5 s" },
    ]);
    expect(inspector?.cancel).toEqual({ state: "ready" });
  });

  test("a queued or finished worker has no cancel control; a finished one shows its end time", async () => {
    const roster = await mixedRoster();
    const queued = buildHubModel(input(roster, { selectedKey: keyOf(roster, "b") })).inspector;
    expect(queued?.cancel).toEqual({ state: "hidden" });
    const finished = buildHubModel(input(roster, { selectedKey: keyOf(roster, "c") })).inspector;
    expect(finished?.cancel).toEqual({ state: "hidden" });
    expect(finished?.facts.map((fact) => fact.label)).toContain("Finished");
  });

  test("cancel reports why it cannot run, and every call phase", async () => {
    const roster = await mixedRoster();
    const key = keyOf(roster, "a");
    const unavailable = buildHubModel(
      input(roster, {
        selectedKey: key,
        cancelAction: { state: "unavailable", reason: "This omp cannot cancel workers." },
      }),
    ).inspector;
    expect(unavailable?.cancel).toEqual({
      state: "unavailable",
      reason: "This omp cannot cancel workers.",
    });
    const phase = (cancels: HubModelInput["cancels"]) =>
      buildHubModel(input(roster, { selectedKey: key, cancels })).inspector?.cancel;
    expect(phase({ [key]: { state: "sending" } })).toEqual({ state: "sending" });
    expect(phase({ [key]: { state: "sent" } })).toEqual({ state: "sent" });
    const gone = new AppFailure({
      code: "not_found",
      message: "Subagent is no longer running",
      retryable: false,
    });
    expect(phase({ [key]: { state: "failed", error: gone.appError } })).toEqual({
      state: "failed",
      message: "This worker has already finished, so there is nothing to cancel.",
      retryable: false,
    });
  });

  test("a transcript button shows its reason until the transcript view is connected", async () => {
    const roster = await mixedRoster();
    const key = keyOf(roster, "a");
    const blocked = buildHubModel(input(roster, { selectedKey: key })).inspector;
    expect(blocked?.transcript).toEqual(NO_TRANSCRIPT);
    const open = buildHubModel(input(roster, { selectedKey: key, transcriptAction: AVAILABLE }));
    expect(open.inspector?.transcript).toEqual(AVAILABLE);
  });

  test("a selection that is no longer in the roster shows no inspector", async () => {
    const roster = await mixedRoster();
    expect(buildHubModel(input(roster, { selectedKey: "gone:0" })).inspector).toBeNull();
  });

  test("progress shows bare counts and the model omp resolved", async () => {
    const store = await fixtureRoster({
      clock: fixtureClock(),
      workers: [
        fixtureWorker("metered", 1, {
          progress: {
            resolvedModel: "anthropic/claude-x:high",
            modelRole: "fast",
            toolCount: 6,
            requests: 3,
            tokens: 18_240,
          },
        }),
      ],
    });
    const snapshot = store.getSnapshot();
    const inspector = buildHubModel(
      input(snapshot, { selectedKey: keyOf(snapshot, "metered") }),
    ).inspector;
    expect(inspector?.progress).toEqual([
      { label: "Model", value: "anthropic/claude-x:high" },
      { label: "Tool calls", value: "6" },
      { label: "Requests", value: "3" },
      { label: "Tokens", value: "18,240" },
    ]);
  });
});

describe("cancelFailureMessage", () => {
  test.each([
    ["not_found", "This worker has already finished, so there is nothing to cancel."],
    ["conflict", "This worker has already finished, so there is nothing to cancel."],
    ["unavailable", "Cancelling workers isn't available in this version of omp."],
    ["omp_error", "The worker could not be cancelled. Try again."],
    ["internal", "The worker could not be cancelled. Try again."],
  ] as const)("%s reads in plain words, never omp's own text", (code, message) => {
    expect(
      cancelFailureMessage({ code, message: "Subagent is no longer running", retryable: false }),
    ).toBe(message);
  });
});
