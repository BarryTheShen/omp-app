import type { OmpEvent, OmpWire } from "@omp-app/contracts";
import { SessionFilePath, SubagentId, ThreadId, ToolCallId } from "@omp-app/contracts";
import { z } from "zod";

const OpenRecord = z.record(z.string(), z.unknown());

export const AgentSourceSchema = z.enum(["bundled", "user", "project", "unknown"]);
export type AgentSource = z.infer<typeof AgentSourceSchema>;

export const AgentStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "aborted",
  "stopped",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const LifecycleStatusSchema = z.enum(["started", "completed", "failed", "aborted"]);
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>;

/** Safe, branded reference passed to T5; no control methods live on this value. */
export const AgentRefSchema = z
  .object({
    id: SubagentId,
    index: z.number().int().nonnegative(),
    agent: z.string().min(1),
    agentSource: AgentSourceSchema,
    status: AgentStatusSchema,
    lastUpdate: z.number().finite(),
    description: z.string().optional(),
    task: z.string().optional(),
    assignment: z.string().optional(),
    progress: OpenRecord.optional(),
    sessionFile: SessionFilePath.optional(),
    parentToolCallId: ToolCallId.optional(),
    detached: z.boolean().optional(),
    reason: z.string().min(1).optional(),
    threadId: ThreadId,
  })
  .strict();
export type AgentRef = z.infer<typeof AgentRefSchema>;

export const AgentRosterSnapshotSchema = z
  .object({
    threadId: ThreadId,
    subagents: z.array(AgentRefSchema),
    subscriptionLevel: z.enum(["off", "progress", "events"]),
    receivedSeq: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type AgentRosterSnapshot = z.infer<typeof AgentRosterSnapshotSchema>;

/** The released wire payload, with C0 brands added at the browser boundary. */
export type SubagentLifecyclePayload = Omit<
  OmpWire.SubagentLifecyclePayload,
  "id" | "sessionFile" | "parentToolCallId"
> & {
  readonly id: SubagentId;
  readonly sessionFile?: SessionFilePath;
  readonly parentToolCallId?: ToolCallId;
};

export const SubagentLifecyclePayloadSchema = z
  .object({
    id: SubagentId,
    agent: z.string().min(1),
    agentSource: AgentSourceSchema,
    status: LifecycleStatusSchema,
    index: z.number().int().nonnegative(),
    description: z.string().optional(),
    sessionFile: SessionFilePath.optional(),
    parentToolCallId: ToolCallId.optional(),
    detached: z.boolean().optional(),
  })
  .strict();

export type SubagentLifecycleEvent = Omit<OmpWire.SubagentLifecycleEvent, "payload"> & {
  readonly payload: SubagentLifecyclePayload;
};

export type SubagentProgressPayload = Omit<
  OmpWire.SubagentProgressPayload,
  "sessionFile" | "parentToolCallId"
> & {
  readonly sessionFile?: SessionFilePath;
  readonly parentToolCallId?: ToolCallId;
};

export const SubagentProgressPayloadSchema = z
  .object({
    index: z.number().int().nonnegative(),
    agent: z.string().min(1),
    agentSource: AgentSourceSchema,
    task: z.string(),
    progress: OpenRecord,
    parentToolCallId: ToolCallId.optional(),
    assignment: z.string().optional(),
    sessionFile: SessionFilePath.optional(),
    detached: z.boolean().optional(),
  })
  .strict();

export type SubagentProgressEvent = Omit<OmpWire.SubagentProgressEvent, "payload"> & {
  readonly payload: SubagentProgressPayload;
};

const OmpEventSchema = z.custom<OmpEvent>((value) => {
  if (value === null || typeof value !== "object" || !("type" in value)) return false;
  return typeof value.type === "string" && value.type.length > 0;
});

export type SubagentEventPayload = Omit<OmpWire.SubagentEventPayload, "id" | "event"> & {
  readonly id: SubagentId;
  readonly event: OmpEvent;
};

export const SubagentEventPayloadSchema = z
  .object({ id: SubagentId, event: OmpEventSchema })
  .strict();

export type SubagentEvent = Omit<OmpWire.SubagentEvent, "payload"> & {
  readonly payload: SubagentEventPayload;
};

export type P1SubagentEvent = SubagentLifecycleEvent | SubagentProgressEvent | SubagentEvent;

/** The exact incremental page returned by `get_subagent_messages`, with safe branded ids. */
export const SubagentTranscriptPageSchema = z
  .object({
    sessionFile: SessionFilePath,
    fromByte: z.number().int().nonnegative(),
    nextByte: z.number().int().nonnegative(),
    reset: z.boolean(),
    entries: z.array(OpenRecord),
    /** OmpMessage is open at the wire level; role is the minimum safe discriminator. */
    messages: z.array(
      z.custom<OmpWire.AgentMessage>((value) => {
        if (value === null || typeof value !== "object" || !("role" in value)) return false;
        return typeof value.role === "string" && value.role.length > 0;
      }),
    ),
  })
  .strict()
  .refine(
    (page) => page.reset || page.nextByte >= page.fromByte,
    "nextByte must advance fromByte unless reset",
  );
export type SubagentTranscriptPage = z.infer<typeof SubagentTranscriptPageSchema>;

export const AdvisorNoteSchema = z
  .object({
    text: z.string().min(1),
    severity: z.enum(["info", "success", "warning", "error", "unknown"]),
    advisor: z.string().min(1).optional(),
    delayedTurns: z.number().int().nonnegative().nullable().optional(),
    timestamp: z.number().finite().optional(),
  })
  .strict();
export type AdvisorNote = z.infer<typeof AdvisorNoteSchema>;

/** Runtime advisor state; missing optional omp fields stay explicitly unknown. */
export const AdvisorStateSchema = z
  .object({
    mode: z.enum(["on", "off", "unknown"]),
    status: z.enum(["idle", "working", "yielded", "error", "unknown"]),
    advisor: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    note: AdvisorNoteSchema.nullable(),
    updatedAt: z.number().finite().optional(),
  })
  .strict();
export type AdvisorState = z.infer<typeof AdvisorStateSchema>;

export const P1CapabilityKeys = {
  roster: "omp.cmd.get_subagents",
  transcript: "omp.cmd.get_subagent_messages",
  cancel: "omp.cmd.cancel_subagent",
  steer: "omp.cmd.steer_subagent",
  subscription: "omp.cmd.set_subagent_subscription",
  events: "omp.subagent-events",
  advisorConfig: "host.config",
  commandGateway: "host.command-gateway",
} as const;
export type P1CapabilityKey = (typeof P1CapabilityKeys)[keyof typeof P1CapabilityKeys];

export const P1SubscriptionLevel = z.enum(["off", "progress", "events"]);
export type P1SubscriptionLevel = z.infer<typeof P1SubscriptionLevel>;

export const SubagentTranscriptReadArgsSchema = z
  .object({ fromByte: z.number().int().nonnegative().optional() })
  .strict();
export type SubagentTranscriptReadArgs = z.infer<typeof SubagentTranscriptReadArgsSchema>;

export const CancelAgentResultSchema = z.object({ cancelled: z.boolean() }).strict();
export type CancelAgentResult = z.infer<typeof CancelAgentResultSchema>;
