import { AppFailure } from "@omp-app/contracts";
import type { P1ClientNotification, SubagentClient, SubscriptionLease } from "@/modules/P1/client";
import {
  type AgentRef,
  type CancelAgentResult,
  canSteerAgent,
  type FocusedAgentReadOptions,
  type FocusedAgentRuntime,
  type FocusedTranscriptListener,
  type NestedTranscriptSource,
  type P1SubagentEvent,
  type SubagentTranscriptPage,
} from "@/modules/P1/contract";
import type { FinishedWorkerSource } from "@/modules/P1/roster";
import { asAppFailure } from "./failures";

/** Receives a live-feed failure that happens after `subscribe` returned, such as the events level not being set. */
export type LiveFailureListener = (failure: AppFailure) => void;

/**
 * What the transcript view needs from one worker: its reference, a byte-cursor read and a live feed.
 * A `NestedTranscriptSource` or a `FocusedAgentRuntime` from this module satisfies it. Live feed
 * failures reach `onFailure` when the caller passes one; the view always does.
 */
export interface TranscriptFeed {
  readonly agent: AgentRef;
  readonly read: (options?: FocusedAgentReadOptions) => Promise<SubagentTranscriptPage>;
  readonly subscribe: (
    listener: FocusedTranscriptListener,
    onFailure?: LiveFailureListener,
  ) => () => void;
}

export interface TranscriptSourceOptions {
  readonly agent: AgentRef;
  readonly client: SubagentClient;
  /** Reads a finished worker's file once omp no longer knows the worker, as after a reload. */
  readonly finished?: Pick<FinishedWorkerSource, "read"> | undefined;
}

function readerFor(
  agent: AgentRef,
  client: SubagentClient,
  finished: TranscriptSourceOptions["finished"],
): TranscriptFeed["read"] {
  return async (options) => {
    const fromByte = options?.fromByte;
    try {
      return await client.readTranscript(agent.id, {
        ...(agent.sessionFile === undefined ? {} : { sessionFile: agent.sessionFile }),
        ...(fromByte === undefined ? {} : { fromByte }),
      });
    } catch (error) {
      // omp answers for a worker only while it still knows the worker. After a reload a finished
      // worker is known only by its file, so that file is read instead.
      if (finished === undefined || agent.sessionFile === undefined || !isFinished(agent)) {
        throw error;
      }
      return finished.read(agent.sessionFile, fromByte);
    }
  };
}

function isFinished(agent: AgentRef): boolean {
  return (
    agent.status === "completed" ||
    agent.status === "failed" ||
    agent.status === "aborted" ||
    agent.status === "stopped"
  );
}

/**
 * Whether a frame concerns this worker: its own id, or for progress (which carries no id) its roster
 * index, and its session file when both sides know one.
 */
function concerns(agent: AgentRef, event: P1SubagentEvent): boolean {
  if (event.type !== "subagent_progress") return event.payload.id === agent.id;
  const file = event.payload.sessionFile;
  return (
    event.payload.index === agent.index &&
    (file === undefined || agent.sessionFile === undefined || file === agent.sessionFile)
  );
}

function subscriberFor(agent: AgentRef, client: SubagentClient): TranscriptFeed["subscribe"] {
  return (listener, onFailure) => {
    // Throws at once when the events capability is missing; the caller shows that as the feed's failure.
    const unsubscribe = client.subscribeNotifications(({ event, seq }: P1ClientNotification) => {
      if (concerns(agent, event)) listener({ threadId: agent.threadId, seq, event });
    });
    let closed = false;
    let lease: SubscriptionLease | undefined;
    const release = (acquired: SubscriptionLease): void => {
      acquired.release().catch((error: unknown) => onFailure?.(asAppFailure(error)));
    };
    // The events level is what makes omp send this worker's frames. Until it is set, the view's own
    // timed reads still keep the transcript current, and the failure is reported to the caller.
    void client.acquireSubscription("events").then(
      (acquired) => {
        if (closed) release(acquired);
        else lease = acquired;
      },
      (error: unknown) => onFailure?.(asAppFailure(error)),
    );
    return () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (lease !== undefined) release(lease);
    };
  };
}

/**
 * The read-only source a nested task card shows: reads and live frames for one worker, and nothing
 * that can change the worker. Its type is the contract's `NestedTranscriptSource`.
 */
export function createNestedTranscriptSource(
  options: TranscriptSourceOptions,
): NestedTranscriptSource & TranscriptFeed {
  const { agent, client } = options;
  return Object.freeze({
    agent,
    read: readerFor(agent, client, options.finished),
    subscribe: subscriberFor(agent, client),
    readOnly: true as const,
  });
}

/**
 * The focused surface for one worker: the same reads and live frames, plus cancel and steer. Both
 * refuse a worker that is not running, so a finished worker can never be changed from here. The
 * runtime holds the roster snapshot it was made from; make a new one when the roster changes.
 */
export function createFocusedAgentRuntime(
  options: TranscriptSourceOptions,
): FocusedAgentRuntime & TranscriptFeed {
  const { agent, client } = options;
  return Object.freeze({
    agent,
    read: readerFor(agent, client, options.finished),
    subscribe: subscriberFor(agent, client),
    readOnly: false as const,
    cancel: async (): Promise<CancelAgentResult> => {
      if (agent.status !== "running") throw notRunning("This worker has already finished.");
      return client.cancel(agent.id);
    },
    steer: async (message: string): Promise<void> => {
      if (!canSteerAgent(agent)) {
        throw notRunning("This worker has finished, so the message was not sent.");
      }
      await client.steer(agent.id, message);
    },
  });
}

function notRunning(message: string): AppFailure {
  return new AppFailure({ code: "conflict", message, retryable: false });
}
