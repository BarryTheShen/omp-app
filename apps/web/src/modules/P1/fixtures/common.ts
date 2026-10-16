import { SessionFilePath, SubagentId, ThreadId } from "@omp-app/contracts";
import type { SubagentClient } from "@/modules/P1/client";
import {
  type AgentRef,
  AgentRefSchema,
  type LifecycleStatus,
  type P1SubagentEvent,
} from "@/modules/P1/contract";
import { AgentRosterStore, type RosterClock } from "@/modules/P1/roster";

/** The chat every fixture belongs to: a synthetic thread id, as the panel playground uses. */
export const FIXTURE_THREAD_ID = ThreadId.parse("fixture-thread");

/** The epoch milliseconds fixtures start from, the same clock value the panel fixtures use. */
export const FIXTURE_START = 1_759_900_000_000;

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;

/**
 * A session file under a synthetic workspace. It has the shape of omp's `<artifactsDir>/<id>.jsonl`;
 * the directory itself is synthetic.
 */
export function fixtureSessionFile(name: string): SessionFilePath {
  return SessionFilePath.parse(`/workspace/artifacts/${name}.jsonl`);
}

/** A roster entry built through the contract schema, so its ids are the branded ones. */
export function fixtureAgent(
  id: string,
  index: number,
  patch: Readonly<Record<string, unknown>> = {},
): AgentRef {
  return AgentRefSchema.parse({
    id: SubagentId.parse(id),
    index,
    agent: "task",
    agentSource: "bundled",
    status: "running",
    lastUpdate: FIXTURE_START + index * SECOND_MS,
    threadId: FIXTURE_THREAD_ID,
    ...patch,
  });
}

/** A lifecycle frame in omp's `subagent_lifecycle` shape, as the contract types it. */
export function lifecycleEvent(
  id: string,
  index: number,
  status: LifecycleStatus,
  sessionFile?: SessionFilePath,
): P1SubagentEvent {
  return {
    type: "subagent_lifecycle",
    payload: {
      id: SubagentId.parse(id),
      agent: "task",
      agentSource: "bundled",
      status,
      index,
      ...(sessionFile === undefined ? {} : { sessionFile }),
    },
  };
}

/** A progress frame in omp's `subagent_progress` shape; `progress` is the open record omp sent. */
export function progressEvent(
  index: number,
  progress: Readonly<Record<string, unknown>>,
  sessionFile?: SessionFilePath,
): P1SubagentEvent {
  return {
    type: "subagent_progress",
    payload: {
      index,
      agent: "task",
      agentSource: "bundled",
      task: typeof progress.task === "string" ? progress.task : "",
      assignment: typeof progress.assignment === "string" ? progress.assignment : undefined,
      progress: { ...progress },
      ...(sessionFile === undefined ? {} : { sessionFile }),
    },
  };
}

export interface FixtureClock extends RosterClock {
  set(ms: number): void;
}

export function fixtureClock(start: number = FIXTURE_START): FixtureClock {
  let current = start;
  return {
    now: () => current,
    set: (ms) => {
      current = ms;
    },
  };
}

/**
 * The roster client a fixture needs. The store is fed by hand, so no command runs here: a call that
 * reaches it is a bug in the fixture, and it fails loudly instead of answering.
 */
function fixtureClient(): SubagentClient {
  const refused = (name: string) => async () => {
    throw new Error(`The fixture roster does not run ${name}.`);
  };
  return {
    getRoster: async () => [],
    readTranscript: refused("readTranscript"),
    cancel: refused("cancel"),
    steer: refused("steer"),
    setSubscriptionLevel: refused("setSubscriptionLevel"),
    acquireSubscription: refused("acquireSubscription"),
    subscribeNotifications: () => () => {},
    dispose: async () => {},
  };
}

/**
 * A real roster store on a fixture clock. The store is not started: a scenario feeds it snapshots
 * through `mergeSnapshot` and frames through `ingestNotification`, the same merge path the app uses.
 */
export function fixtureRosterStore(clock: FixtureClock): AgentRosterStore {
  return new AgentRosterStore({ threadId: FIXTURE_THREAD_ID, client: fixtureClient(), clock });
}

/** One step of a roster scenario: a snapshot from omp's `get_subagents`, or one notification frame. */
export type RosterStep =
  | { readonly kind: "snapshot"; readonly at: number; readonly agents: readonly AgentRef[] }
  | {
      readonly kind: "frame";
      readonly at: number;
      readonly seq: number;
      readonly event: P1SubagentEvent;
    };
