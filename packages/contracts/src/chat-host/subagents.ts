/**
 * Subagents (SDK plan H5.2f): the session's running subagents, their transcripts, and the app's hard kill of and chat
 * with one, as omp's RPC subagent registry (18.12.6 `modes/rpc/rpc-subagents.ts`, `rpc-mode.ts:783-862`).
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type {
  SubagentEventPayload,
  SubagentLifecyclePayload,
  SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task/types";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { z } from "zod";

/** `off`: no events; `progress`: lifecycle and progress events; `events`: also each subagent's own session events. */
export const SubagentSubscriptionLevel = z.enum(["off", "progress", "events"]);
export type SubagentSubscriptionLevel = z.infer<typeof SubagentSubscriptionLevel>;

export const SubagentSubscriptionParams = z.object({ level: SubagentSubscriptionLevel });
export type SubagentSubscriptionParams = z.infer<typeof SubagentSubscriptionParams>;

/**
 * A transcript from a byte offset (`fromByte`, 0 by default): by the subagent's id, or by a transcript file this
 * session's subagents wrote.
 */
export const SubagentMessagesParams = z
  .object({
    subagentId: z.string().min(1).optional(),
    sessionFile: z.string().min(1).optional(),
    fromByte: z.number().optional(),
  })
  .refine((params) => params.subagentId !== undefined || params.sessionFile !== undefined, {
    message: "get_subagent_messages requires subagentId or sessionFile",
  });
export type SubagentMessagesParams = z.infer<typeof SubagentMessagesParams>;

export const SubagentIdParams = z.object({ subagentId: z.string().min(1) });
export type SubagentIdParams = z.infer<typeof SubagentIdParams>;

export const SteerSubagentParams = z.object({
  subagentId: z.string().min(1),
  message: z
    .string()
    .refine((message) => message.trim().length > 0, "`message` is required for steer_subagent."),
});
export type SteerSubagentParams = z.infer<typeof SteerSubagentParams>;

/** One running subagent, as omp's roster keeps it (`RpcSubagentSnapshot`). */
export interface SubagentSnapshot {
  readonly id: string;
  readonly index: number;
  readonly agent: string;
  readonly agentSource: AgentProgress["agentSource"];
  readonly description?: string;
  readonly status: AgentProgress["status"];
  readonly task?: string;
  readonly assignment?: string;
  readonly sessionFile?: string;
  /** When omp last reported on it, in milliseconds. */
  readonly lastUpdate: number;
  readonly progress?: AgentProgress;
  readonly parentToolCallId?: string;
}

/**
 * Whole lines of a transcript from `fromByte`; `nextByte` is where the next read starts. `reset` when the file was
 * shorter than `fromByte` (it was replaced), so the reading started over.
 */
export interface SubagentTranscript {
  readonly sessionFile: string;
  readonly fromByte: number;
  readonly nextByte: number;
  readonly reset: boolean;
  readonly entries: readonly FileEntry[];
  readonly messages: readonly AgentMessage[];
}

export interface SubagentLifecycleEvent {
  readonly type: "subagent_lifecycle";
  readonly payload: SubagentLifecyclePayload;
}

export interface SubagentProgressEvent {
  readonly type: "subagent_progress";
  readonly payload: SubagentProgressPayload;
}

/** A subagent's own session event, at the `events` level. */
export interface SubagentSessionEvent {
  readonly type: "subagent_event";
  readonly payload: SubagentEventPayload;
}

export type SubagentEvent = SubagentLifecycleEvent | SubagentProgressEvent | SubagentSessionEvent;
