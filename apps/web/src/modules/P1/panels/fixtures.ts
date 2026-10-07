import { SubagentId, ThreadId } from "@omp-app/contracts";
import type { SubagentClient } from "@/modules/P1/client";
import { type AgentRef, AgentRefSchema, type P1SubagentEvent } from "@/modules/P1/contract";
import { AgentRosterStore, type RosterClock } from "@/modules/P1/roster";

/** Synthetic workers for tests and the static playground: no real ids, paths, keys or prompts. */
export const FIXTURE_THREAD_ID = ThreadId.parse("fixture-thread");
export const FIXTURE_NOW = 1_759_900_000_000;

export interface FixtureClock extends RosterClock {
  set(ms: number): void;
}

export function fixtureClock(start: number = FIXTURE_NOW): FixtureClock {
  let current = start;
  return {
    now: () => current,
    set: (ms) => {
      current = ms;
    },
  };
}

export function fixtureWorker(
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
    lastUpdate: FIXTURE_NOW + index * 1000,
    threadId: FIXTURE_THREAD_ID,
    ...patch,
  });
}

export function lifecycleEvent(
  id: string,
  index: number,
  status: "started" | "completed" | "failed" | "aborted",
): P1SubagentEvent {
  return {
    type: "subagent_lifecycle",
    payload: { id: SubagentId.parse(id), agent: "task", agentSource: "bundled", status, index },
  };
}

function fixtureClient(workers: readonly AgentRef[]): SubagentClient {
  return {
    getRoster: async () => workers,
    readTranscript: async () => {
      throw new Error("The fixture roster has no transcripts.");
    },
    cancel: async () => ({ cancelled: true as const }),
    steer: async () => {},
    setSubscriptionLevel: async (level) => level,
    acquireSubscription: async (level) => ({ level, release: async () => {} }),
    subscribeNotifications: () => () => {},
    dispose: async () => {},
  };
}

export interface FixtureEvent {
  /** The clock time the event is applied at, so terminal times are chosen by the fixture. */
  readonly at: number;
  readonly seq: number;
  readonly event: P1SubagentEvent;
}

/** A real AgentRosterStore (P1.3) fed by a fake client: the same merge path the app uses. */
export async function fixtureRoster(options: {
  readonly workers: readonly AgentRef[];
  readonly clock: FixtureClock;
  readonly events?: readonly FixtureEvent[];
}): Promise<AgentRosterStore> {
  const store = new AgentRosterStore({
    threadId: FIXTURE_THREAD_ID,
    client: fixtureClient(options.workers),
    clock: options.clock,
  });
  await store.start();
  for (const { at, seq, event } of options.events ?? []) {
    options.clock.set(at);
    store.ingestNotification(event, seq);
  }
  return store;
}
