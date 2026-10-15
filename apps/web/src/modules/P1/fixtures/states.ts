import { AppError } from "@omp-app/contracts";
import type {
  ActionAvailability,
  CancelPhase,
  HubLoad,
  HubModelInput,
  HubView,
} from "@/modules/P1/panels/model";
import {
  FIXTURE_START,
  type FixtureClock,
  fixtureAgent,
  fixtureClock,
  fixtureRosterStore,
  fixtureSessionFile,
  lifecycleEvent,
  MINUTE_MS,
  progressEvent,
  type RosterStep,
  SECOND_MS,
} from "./common";
import { RECORDED_PROGRESS } from "./roster";

/**
 * The states the Agent Hub panel must show, as the inputs its view model is built from. Each state names
 * the worker it selects by id; {@link hubStateInput} turns it into the real `HubModelInput`.
 */
export interface HubStateSpec {
  readonly steps: readonly RosterStep[];
  readonly load: HubLoad;
  readonly view: HubView;
  readonly selectedId: string | null;
  readonly cancelsById: Readonly<Record<string, CancelPhase>>;
  readonly cancelAction: ActionAvailability;
  readonly transcriptAction: ActionAvailability;
  /** The clock time the panel reads durations at. */
  readonly now: number;
}

const READY: ActionAvailability = { state: "available" };
const RUNNING_ID = "worker-hub-running";
const FINISHED_ID = "worker-hub-finished";
export const UNDESCRIBED_WORKER_ID = "PlainWorker";
const START = FIXTURE_START;

const RUNNING_STEPS: readonly RosterStep[] = [
  {
    kind: "snapshot",
    at: START,
    agents: [
      fixtureAgent(RUNNING_ID, 0, {
        description: "Index the repository",
        sessionFile: fixtureSessionFile(RUNNING_ID),
      }),
    ],
  },
  {
    kind: "frame",
    at: START + SECOND_MS,
    seq: 1,
    event: progressEvent(
      0,
      { ...RECORDED_PROGRESS, id: RUNNING_ID },
      fixtureSessionFile(RUNNING_ID),
    ),
  },
];

const LOAD_ERROR = AppError.parse({
  code: "omp_error",
  message: "omp did not return the agents.",
  retryable: true,
});

const LONG_DESCRIPTION =
  "Review every changed file for regressions and summarize each finding in one sentence, then list the files this session could not open because they were too large to read in full, with the reason for each.";

const base: Omit<HubStateSpec, "steps" | "load"> = {
  view: "list",
  selectedId: RUNNING_ID,
  cancelsById: {},
  cancelAction: READY,
  transcriptAction: READY,
  now: START + MINUTE_MS,
};

/** The hub's visual and accessibility states, by name. */
export const HUB_STATE_FIXTURES: Readonly<Record<string, HubStateSpec>> = {
  loading: {
    ...base,
    steps: [],
    load: { state: "loading" },
    selectedId: null,
    now: START,
  },
  empty: {
    ...base,
    steps: [],
    load: { state: "ready" },
    selectedId: null,
    now: START,
  },
  error: {
    ...base,
    steps: [],
    load: { state: "error", error: LOAD_ERROR },
    selectedId: null,
    now: START,
  },
  unavailable: {
    ...base,
    steps: [],
    load: { state: "unavailable", reason: "This version of omp does not report its agents." },
    selectedId: null,
    now: START,
  },
  running: {
    ...base,
    steps: RUNNING_STEPS,
    load: { state: "ready" },
  },
  "no description": {
    ...base,
    steps: [
      {
        kind: "snapshot",
        at: START,
        agents: [
          fixtureAgent(UNDESCRIBED_WORKER_ID, 0, {
            sessionFile: fixtureSessionFile(UNDESCRIBED_WORKER_ID),
          }),
        ],
      },
    ],
    load: { state: "ready" },
    selectedId: UNDESCRIBED_WORKER_ID,
  },
  "cancel sending": {
    ...base,
    steps: RUNNING_STEPS,
    load: { state: "ready" },
    cancelsById: { [RUNNING_ID]: { state: "sending" } },
  },
  "cancel refused": {
    ...base,
    steps: RUNNING_STEPS,
    load: { state: "ready" },
    cancelsById: { [RUNNING_ID]: { state: "refused" } },
  },
  "cancel failed": {
    ...base,
    steps: RUNNING_STEPS,
    load: { state: "ready" },
    cancelsById: {
      [RUNNING_ID]: {
        state: "failed",
        error: AppError.parse({ code: "not_found", message: "Not running", retryable: false }),
      },
    },
  },
  "cancel unavailable": {
    ...base,
    steps: RUNNING_STEPS,
    load: { state: "ready" },
    cancelAction: { state: "unavailable", reason: "This version of omp cannot cancel agents." },
  },
  "transcript unavailable": {
    ...base,
    steps: RUNNING_STEPS,
    load: { state: "ready" },
    transcriptAction: {
      state: "unavailable",
      reason: "omp did not save this worker's transcript.",
    },
  },
  finished: {
    ...base,
    steps: [
      {
        kind: "snapshot",
        at: START,
        agents: [fixtureAgent(FINISHED_ID, 0, { description: "Check the schema" })],
      },
      {
        kind: "frame",
        at: START + 30 * SECOND_MS,
        seq: 1,
        event: lifecycleEvent(FINISHED_ID, 0, "aborted"),
      },
    ],
    load: { state: "ready" },
    selectedId: FINISHED_ID,
  },
  "long description": {
    ...base,
    steps: [
      {
        kind: "snapshot",
        at: START,
        agents: [fixtureAgent(RUNNING_ID, 0, { description: LONG_DESCRIPTION })],
      },
    ],
    load: { state: "ready" },
  },
  "grouped by parent": {
    ...base,
    steps: [
      {
        kind: "snapshot",
        at: START,
        agents: [
          fixtureAgent("worker-group-1", 0, {
            description: "Summarize the logs",
            parentToolCallId: "tool-call-1",
          }),
          fixtureAgent("worker-group-2", 1, {
            description: "Check the schema",
            parentToolCallId: "tool-call-2",
          }),
        ],
      },
    ],
    load: { state: "ready" },
    view: "byParent",
    selectedId: null,
  },
};

/** The panel's input for one state: the store takes the state's steps on a fixture clock, as the app does. */
export function hubStateInput(spec: HubStateSpec): HubModelInput {
  const clock: FixtureClock = fixtureClock(START);
  const store = fixtureRosterStore(clock);
  for (const step of spec.steps) {
    clock.set(step.at);
    if (step.kind === "snapshot") store.mergeSnapshot(step.agents);
    else store.ingestNotification(step.event, step.seq);
  }
  const roster = store.getSnapshot();
  // A worker id can appear twice (a finished worker and its reused id); the later one in roster order is the current one.
  const keyById = new Map<string, string>();
  for (const key of roster.order) {
    const agent = roster.agents[key];
    if (agent !== undefined) keyById.set(agent.id, key);
  }
  const cancels: Record<string, CancelPhase> = {};
  for (const [id, phase] of Object.entries(spec.cancelsById)) {
    const key = keyById.get(id);
    if (key !== undefined) cancels[key] = phase;
  }
  return {
    roster,
    load: spec.load,
    view: spec.view,
    selectedKey: spec.selectedId === null ? null : (keyById.get(spec.selectedId) ?? null),
    cancels,
    cancelAction: spec.cancelAction,
    transcriptAction: spec.transcriptAction,
    now: spec.now,
  };
}
