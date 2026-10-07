import { AppErrorCode, AppFailure, CapabilityKey, type CapabilityMap } from "@omp-app/contracts";
import { z } from "zod";
import type { NestedTranscriptSource } from "../P1/contract/runtime";
import { AgentRefSchema, AgentStatusSchema } from "../P1/contract/types";
import { OutputMetaSchema } from "../U3/tool-card/output-meta";

const OpenRecord = z.record(z.string(), z.unknown());
const OptionalText = z.string().min(1).optional();

export const T5CapabilityKeys = {
  subagentEvents: "omp.subagent-events",
  commandGateway: "host.command-gateway",
} as const satisfies Record<string, CapabilityKey>;
export type T5CapabilityKey = (typeof T5CapabilityKeys)[keyof typeof T5CapabilityKeys];

/** T5 cards remain visible without these capabilities; only live controls are gated. */
export function hasT5Capability(capabilities: CapabilityMap, key: T5CapabilityKey): boolean {
  return capabilities[key]?.state === "available";
}

export const ToolIdentitySchema = z.looseObject({
  toolCallId: OptionalText,
  parentTaskId: OptionalText,
  depth: z.number().int().nonnegative().optional(),
  jobId: OptionalText,
  agentId: OptionalText,
  session: OptionalText,
  fromByte: z.number().int().nonnegative().optional(),
  nextByte: z.number().int().nonnegative().optional(),
});
export const NestedTranscriptSnapshotSchema = z.looseObject({
  parentTaskId: OptionalText,
  depth: z.number().int().nonnegative(),
  messages: z.array(z.unknown()),
  sessionFile: OptionalText,
  fromByte: z.number().int().nonnegative().optional(),
  nextByte: z.number().int().nonnegative().optional(),
  reset: z.boolean().optional(),
});
export type NestedTranscriptSnapshot = z.infer<typeof NestedTranscriptSnapshotSchema>;
export type { NestedTranscriptSource };

export const TaskToolArgsSchema = z.looseObject({
  prompt: OptionalText,
  agent: OptionalText,
  description: OptionalText,
  assignment: OptionalText,
  model: OptionalText,
});
export type TaskToolArgs = z.infer<typeof TaskToolArgsSchema>;

export const TaskProgressSchema = z.looseObject({
  percent: z.number().min(0).max(100).optional(),
  phase: OptionalText,
  currentWork: OptionalText,
  currentTool: OptionalText,
});
export type TaskProgress = z.infer<typeof TaskProgressSchema>;
export const TaskLifecycleSnapshotSchema = z.looseObject({
  id: OptionalText,
  status: z.enum(["started", "completed", "failed", "aborted"]).optional(),
  agent: OptionalText,
  index: z.number().int().nonnegative().optional(),
  parentToolCallId: OptionalText,
  sessionFile: OptionalText,
  detached: z.boolean().optional(),
  error: z.unknown().optional(),
});
export type TaskLifecycleSnapshot = z.infer<typeof TaskLifecycleSnapshotSchema>;

export const TaskEventSnapshotSchema = z.looseObject({
  id: OptionalText,
  type: OptionalText,
  toolCallId: OptionalText,
  at: z.number().finite().optional(),
  event: z.unknown().optional(),
  payload: z.unknown().optional(),
});
export type TaskEventSnapshot = z.infer<typeof TaskEventSnapshotSchema>;

export const JobSnapshotSchema = z.looseObject({
  id: OptionalText,
  type: z.enum(["bash", "task", "eval"]).optional(),
  status: z.enum(["running", "completed", "failed", "cancelled"]).optional(),
  label: OptionalText,
  durationMs: z.number().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  model: OptionalText,
  thinking: OptionalText,
  completion: z.number().min(0).max(100).optional(),
  result: z.unknown().optional(),
  structured: z.unknown().optional(),
  structuredOutput: z.unknown().optional(),
  error: z.unknown().optional(),
  agentUrl: OptionalText,
  meta: OpenRecord.optional(),
});
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;

export const IrcMessageSchema = z.looseObject({
  id: OptionalText,
  from: OptionalText,
  to: OptionalText,
  text: OptionalText,
  message: OptionalText,
  timestamp: z.number().finite().optional(),
  status: OptionalText,
});
export type IrcMessage = z.infer<typeof IrcMessageSchema>;

export const IrcReceiptSchema = z.looseObject({
  id: OptionalText,
  accepted: z.boolean().optional(),
  delivered: z.boolean().optional(),
  messageId: OptionalText,
  error: z.unknown().optional(),
});
export type IrcReceipt = z.infer<typeof IrcReceiptSchema>;

export const HubDetailsSchema = z.looseObject({
  ...ToolIdentitySchema.shape,
  op: OptionalText,
  target: OptionalText,
  status: OptionalText,
  agents: z.array(AgentRefSchema).optional(),
  jobs: z.array(JobSnapshotSchema).optional(),
  messages: z.array(IrcMessageSchema).optional(),
  receipts: z.array(IrcReceiptSchema).optional(),
  receipt: IrcReceiptSchema.optional(),
  waited: IrcMessageSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  partial: z.boolean().optional(),
  result: z.unknown().optional(),
  outputMeta: OutputMetaSchema.optional(),
  error: z.unknown().optional(),
});
export type HubDetails = z.infer<typeof HubDetailsSchema>;

export const TaskDetailsSchema = z.looseObject({
  ...ToolIdentitySchema.shape,
  status: AgentStatusSchema.optional(),
  label: OptionalText,
  task: OptionalText,
  assignment: OptionalText,
  progress: TaskProgressSchema.optional(),
  lifecycle: TaskLifecycleSnapshotSchema.optional(),
  events: z.array(TaskEventSnapshotSchema).optional(),
  completionPercent: z.number().min(0).max(100).optional(),
  agent: AgentRefSchema.optional(),
  children: z.array(AgentRefSchema).optional(),
  nested: z.unknown().optional(),
  transcript: NestedTranscriptSnapshotSchema.optional(),
  output: z.unknown().optional(),
  outputMeta: OutputMetaSchema.optional(),
  model: OptionalText,
  effort: OptionalText,
  thinking: OptionalText,
  usage: OpenRecord.optional(),
  cost: OpenRecord.optional(),
  context: OpenRecord.optional(),
  requests: z.number().int().nonnegative().optional(),
  tokens: OpenRecord.optional(),
  durationMs: z.number().nonnegative().optional(),
  merge: OpenRecord.optional(),
  error: z.unknown().optional(),
});
export type TaskDetails = z.infer<typeof TaskDetailsSchema>;

export const CoordinationDetailsSchema = z.looseObject({
  ...ToolIdentitySchema.shape,
  op: z.enum(["send", "wait", "jobs", "cancel"]).optional(),
  from: OptionalText,
  to: OptionalText,
  message: OptionalText,
  messages: z.array(IrcMessageSchema).optional(),
  receipts: z.array(IrcReceiptSchema).optional(),
  receipt: IrcReceiptSchema.optional(),
  waited: IrcMessageSchema.optional(),
  jobs: z.array(JobSnapshotSchema).optional(),
  cancelled: z.array(JobSnapshotSchema).optional(),
  agents: z.array(AgentRefSchema).optional(),
  interrupted: z.boolean().optional(),
  meta: OpenRecord.optional(),
  outputMeta: OutputMetaSchema.optional(),
  error: z.unknown().optional(),
});
export type CoordinationDetails = z.infer<typeof CoordinationDetailsSchema>;

export const VibeSpawnArgsSchema = z.looseObject({
  cli: z.enum(["fast", "good"]),
  name: OptionalText,
  prompt: z.string(),
});
export type VibeSpawnArgs = z.infer<typeof VibeSpawnArgsSchema>;

export const VibeSendArgsSchema = z.looseObject({ session: z.string(), message: z.string() });
export type VibeSendArgs = z.infer<typeof VibeSendArgsSchema>;

export const VibeWaitArgsSchema = z.looseObject({
  sessions: z.array(z.string()).optional(),
  timeout: z.number().nonnegative().optional(),
});
export type VibeWaitArgs = z.infer<typeof VibeWaitArgsSchema>;

export const VibeKillArgsSchema = z.looseObject({ session: z.string() });
export type VibeKillArgs = z.infer<typeof VibeKillArgsSchema>;

export const VibeListArgsSchema = z.looseObject({});
export type VibeListArgs = z.infer<typeof VibeListArgsSchema>;

export const VibeScreenSchema = z.looseObject({
  name: OptionalText,
  lines: z.array(z.string()).optional(),
  updatedAt: z.number().optional(),
});
export type VibeScreen = z.infer<typeof VibeScreenSchema>;

export const VibeDetailsSchema = z.looseObject({
  ...ToolIdentitySchema.shape,
  op: z.enum(["spawn", "send", "list", "wait", "kill"]).optional(),
  cli: z.enum(["fast", "good"]).optional(),
  screens: z.array(VibeScreenSchema).optional(),
  hiddenKilled: z.boolean().optional(),
  spawned: z.unknown().optional(),
  send: z.unknown().optional(),
  wait: z
    .looseObject({
      settled: z.array(z.string()).optional(),
      stillRunning: z.array(z.string()).optional(),
      timedOut: z.boolean().optional(),
    })
    .optional(),
  killed: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type VibeDetails = z.infer<typeof VibeDetailsSchema>;

export const YieldDetailsSchema = z.looseObject({
  ...ToolIdentitySchema.shape,
  data: z.unknown().optional(),
  status: z.enum(["success", "aborted"]).optional(),
  error: z.unknown().optional(),
  type: z.union([z.string(), z.array(z.string())]).optional(),
  useLastTurn: z.boolean().optional(),
  complete: z.boolean().optional(),
  schemaOverridden: z.boolean().optional(),
  outputMeta: OutputMetaSchema.optional(),
});
export type YieldDetails = z.infer<typeof YieldDetailsSchema>;

export const WaitDetailsSchema = z.looseObject({
  ...CoordinationDetailsSchema.shape,
  sealed: z.boolean().optional(),
  summary: OpenRecord.optional(),
});
export type WaitDetails = z.infer<typeof WaitDetailsSchema>;

export const T5ToolFailureSchema = z.looseObject({
  code: AppErrorCode.optional(),
  message: z.string().min(1).optional(),
  retryable: z.boolean().optional(),
  capability: CapabilityKey.optional(),
  cancelled: z.boolean().optional(),
  timedOut: z.boolean().optional(),
  omp: OpenRecord.optional(),
});
export type T5ToolFailure = z.infer<typeof T5ToolFailureSchema>;

export type T5DetailDecode<T> =
  | { readonly ok: true; readonly value: T; readonly raw: unknown }
  | { readonly ok: false; readonly error: AppFailure; readonly raw: unknown };

function decode<T>(schema: z.ZodType<T>, raw: unknown, label: string): T5DetailDecode<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data, raw };
  return {
    ok: false,
    error: new AppFailure({
      code: "invalid_args",
      message: `Malformed ${label}; showing the raw tool result.`,
      retryable: false,
    }),
    raw,
  };
}

export function decodeTaskDetails(raw: unknown): T5DetailDecode<TaskDetails> {
  return decode(TaskDetailsSchema, raw, "task");
}
export function decodeHubDetails(raw: unknown): T5DetailDecode<HubDetails> {
  return decode(HubDetailsSchema, raw, "hub");
}
export function decodeWaitDetails(raw: unknown): T5DetailDecode<WaitDetails> {
  return decode(WaitDetailsSchema, raw, "wait");
}
export function decodeVibeDetails(raw: unknown): T5DetailDecode<VibeDetails> {
  return decode(VibeDetailsSchema, raw, "vibe");
}
export function decodeYieldDetails(raw: unknown): T5DetailDecode<YieldDetails> {
  return decode(YieldDetailsSchema, raw, "yield");
}
export function decodeToolFailure(raw: unknown): T5DetailDecode<T5ToolFailure> {
  return decode(T5ToolFailureSchema, raw, "tool failure");
}

/** Converts a normalized tool failure without echoing arbitrary raw fields into an AppFailure. */
export function toT5AppFailure(raw: unknown, fallback: AppErrorCode = "omp_error"): AppFailure {
  const parsed = T5ToolFailureSchema.safeParse(raw);
  const value = parsed.success ? parsed.data : {};
  const code = value.cancelled
    ? "cancelled"
    : value.timedOut
      ? "timeout"
      : (value.code ?? fallback);
  return new AppFailure({
    code,
    message: value.message ?? "The agent tool reported an error.",
    retryable: value.retryable ?? (code === "timeout" || code === "omp_error"),
    ...(value.capability ? { capability: value.capability } : {}),
  });
}
