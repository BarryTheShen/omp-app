import type { AppError, ThreadId } from "@omp-app/contracts";
import type { AgentRef, CancelAgentResult, P1SubagentEvent, SubagentTranscriptPage } from "./types";

export type FocusedTranscriptEvent = {
  readonly threadId: ThreadId;
  readonly seq: number;
  readonly event: P1SubagentEvent;
};

export type FocusedTranscriptListener = (event: FocusedTranscriptEvent) => void;

export type FocusedAgentReadOptions = {
  readonly fromByte?: number;
};

/**
 * Read-only nested source exposed to T5. It deliberately has no cancel/steer methods: nested task
 * cards cannot mutate or answer a worker. P1's focused surface uses the richer runtime below.
 */
export interface NestedTranscriptSource {
  readonly agent: AgentRef;
  readonly read: (options?: FocusedAgentReadOptions) => Promise<SubagentTranscriptPage>;
  readonly subscribe: (listener: FocusedTranscriptListener) => () => void;
  readonly readOnly: true;
}

/** Focused P1 surface: one selected running worker may be cancelled or steered. */
export interface FocusedAgentRuntime {
  readonly agent: AgentRef;
  readonly read: (options?: FocusedAgentReadOptions) => Promise<SubagentTranscriptPage>;
  readonly subscribe: (listener: FocusedTranscriptListener) => () => void;
  readonly readOnly: false;
  readonly cancel: () => Promise<CancelAgentResult>;
  readonly steer: (message: string) => Promise<void>;
  readonly failure?: AppError;
}

export function canSteerAgent(agent: AgentRef): boolean {
  return agent.status === "running";
}
