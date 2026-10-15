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
 * One worker's runtime: its reads and live frames, and cancel and steer. The focused P1 surface and a
 * nested task card share it, and both refuse a worker that is not running.
 */
export interface FocusedAgentRuntime {
  readonly agent: AgentRef;
  readonly read: (options?: FocusedAgentReadOptions) => Promise<SubagentTranscriptPage>;
  readonly subscribe: (listener: FocusedTranscriptListener) => () => void;
  readonly cancel: () => Promise<CancelAgentResult>;
  readonly steer: (message: string) => Promise<void>;
  readonly failure?: AppError;
}

export function canSteerAgent(agent: AgentRef): boolean {
  return agent.status === "running";
}
