import type { CapabilityMap, ThreadId, ToolCallId } from "@omp-app/contracts";
import {
  createSubagentClient,
  type SubagentClient,
  type SubagentSession,
} from "@/modules/P1/client";
import {
  AgentRosterStore,
  createChatFinishedWorkers,
  type FinishedWorkerSource,
  type RosterAgent,
  type SessionTranscriptFiles,
} from "@/modules/P1/roster";
import { createFocusedAgentRuntime } from "@/modules/P1/transcript";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import type { TaskSubagent } from "@/modules/T5/task";

/**
 * One chat's subagents: the roster and the client it reads through. The Agents tab and the task cards in
 * the chat share it. Nothing is subscribed until the first `start()`; `dispose()` releases what it took.
 */
export interface ThreadAgents {
  readonly threadId: ThreadId;
  readonly client: SubagentClient;
  readonly roster: AgentRosterStore;
  /** The chat's workers that finished, read from their transcripts: a transcript view reads them after a reload. */
  readonly finished: FinishedWorkerSource;
  /** Subscribes to progress and loads the roster on the first call; every later call waits for that same start. */
  start(): Promise<void>;
  /**
   * The workers a task call started: those the roster ties to the call, and those whose ids its result names
   * (a worker that ended before the roster subscribed has no tie, only its id and its transcript).
   */
  subagentsFor(
    parentToolCallId: ToolCallId,
    workerIds?: readonly string[],
  ): readonly TaskSubagent[];
  /** The newest worker the roster knows by this id, with its transcript; undefined when the chat does not know it. */
  workerFor(id: string): TaskSubagent | undefined;
  /** Releases the progress subscription and the roster. Calling it again does nothing. */
  dispose(): Promise<void>;
}

export interface ThreadAgentsOptions {
  readonly threadId: ThreadId;
  readonly store: OmpRuntimeStore;
  readonly session: SubagentSession;
  /** The chat's files on the server: a reload lists the workers that finished in them. */
  readonly files: SessionTranscriptFiles;
  readonly capabilities: CapabilityMap;
}

export function createThreadAgents({
  threadId,
  store,
  session,
  files,
  capabilities,
}: ThreadAgentsOptions): ThreadAgents {
  const client = createSubagentClient({ threadId, session, runtime: store, capabilities });
  const finished = createChatFinishedWorkers({ threadId, session, files, capabilities });
  const roster = new AgentRosterStore({ threadId, client, finished });
  // One source per worker: a roster update that keeps a worker keeps its source, so its view is not re-read.
  const sources = new Map<string, TaskSubagent>();
  let starting: Promise<void> | undefined;
  let disposed = false;
  const sourceFor = (agent: RosterAgent): TaskSubagent => {
    const cached = sources.get(agent.key);
    if (cached !== undefined && cached.agent === agent) return cached;
    const next: TaskSubagent = {
      agent,
      source: createFocusedAgentRuntime({ agent, client, finished }),
    };
    sources.set(agent.key, next);
    return next;
  };
  return {
    threadId,
    client,
    roster,
    finished,
    start() {
      if (starting === undefined) {
        starting = roster.start().catch((error: unknown) => {
          // A failed start is not remembered, so the next caller starts the roster again.
          starting = undefined;
          throw error;
        });
      }
      return starting;
    },
    subagentsFor(parentToolCallId, workerIds = []) {
      const snapshot = roster.getSnapshot();
      return snapshot.order
        .map((key) => snapshot.agents[key])
        .filter(
          (agent): agent is RosterAgent =>
            agent !== undefined &&
            (agent.parentToolCallId === parentToolCallId || workerIds.includes(agent.id)),
        )
        .map(sourceFor);
    },
    workerFor(id) {
      const snapshot = roster.getSnapshot();
      // An id omp reuses names a later incarnation of the worker: the newest one is the worker a notice means.
      let latest: RosterAgent | undefined;
      for (const key of snapshot.order) {
        const agent = snapshot.agents[key];
        if (agent?.id === id && (latest === undefined || agent.incarnation > latest.incarnation)) {
          latest = agent;
        }
      }
      return latest === undefined ? undefined : sourceFor(latest);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      sources.clear();
      await roster.dispose();
      await client.dispose();
    },
  };
}
