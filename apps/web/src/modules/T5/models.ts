import { AppErrorCode, AppFailure, CapabilityKey, type CapabilityMap } from "@omp-app/contracts";
import { z } from "zod";
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

// The shapes below are omp 18.6.1's wire types for the wait, hub and task tools:
// `CoordinationDetails`, `IrcMessage`, `IrcDeliveryReceipt` and `JobSnapshot` in
// `@oh-my-pi/pi-tui/tools/wait` and `tools/irc`; `TaskToolDetails`, `AgentProgress` and `SingleResult`
// in `@oh-my-pi/pi-tui/tools/task`; `DaemonSnapshot` in `@oh-my-pi/pi-tui/tools/daemon`.

/** A peer message, as `wait` returns it in `details.waited` and as hub sends it. */
export const IrcMessageSchema = z.looseObject({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  body: z.string(),
  ts: z.number().finite(),
  replyTo: OptionalText,
  wakeRelay: z.boolean().optional(),
});
export type IrcMessage = z.infer<typeof IrcMessageSchema>;

/** Delivery outcome for one recipient of a hub send. */
export const IrcReceiptSchema = z.looseObject({
  to: z.string().min(1),
  outcome: z.enum(["injected", "woken", "revived", "failed"]),
  error: OptionalText,
});
export type IrcReceipt = z.infer<typeof IrcReceiptSchema>;

/** A background job row in a wait, jobs or cancel result. */
export const JobSnapshotSchema = z.looseObject({
  id: z.string().min(1),
  type: z.enum(["bash", "task", "eval"]),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  label: z.string(),
  durationMs: z.number().nonnegative(),
  exitCode: z.number().int().optional(),
  resolvedModel: OptionalText,
  resolvedModelIdentity: OptionalText,
  resolvedThinkingLevel: OptionalText,
  advisor: z.boolean().optional(),
  completionPercent: z.number().min(0).max(100).optional(),
  resultText: z.string().optional(),
  errorText: z.string().optional(),
  meta: OpenRecord.optional(),
  artifactError: z.unknown().optional(),
  structured: OpenRecord.optional(),
  agentUrlId: OptionalText,
});
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;

/** omp's `<task-result>` envelope (`prompts/tools/task-summary.md`), and the parts of it a row shows. */
const TASK_RESULT = /<task-result\b[^>]*>([\s\S]*?)<\/task-result>/u;
const TASK_ERROR = /<error\b[^>]*>([\s\S]*?)<\/error>/u;
const TASK_OUTPUT = /<(output|preview)\b[^>]*>([\s\S]*?)<\/\1>/u;

/**
 * The text of a job's result or error that a Tasks row shows. A task's text is omp's `<task-result>` envelope. Its
 * `<error>` is why the run failed, when it failed after it produced text (task-result.ts sets it only then), and its
 * `<output>`, or its `<preview>` when the output was cut, is what the worker produced, or the preview of the error when
 * it produced nothing. The reason comes first. The envelope's status, duration and abort reason are for the model, and
 * the row's chip and stop line already say how the job ended, so none of them is shown. Text without an envelope (a
 * command's output) is shown as it is. Undefined when there is no text to show.
 */
export function shownJobText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const envelope = TASK_RESULT.exec(text);
  if (envelope === null) return text.length > 0 ? text : undefined;
  const body = envelope[1] ?? "";
  const reason = TASK_ERROR.exec(body)?.[1]?.trim() ?? "";
  const output = TASK_OUTPUT.exec(body)?.[2]?.trim() ?? "";
  const shown = [reason, output].filter((part) => part.length > 0).join("\n\n");
  return shown.length > 0 ? shown : undefined;
}

/** A cancel outcome for one job: `cancelled`, `not_found` or `already_completed`. */
export const CancelOutcomeSchema = z.looseObject({
  id: z.string().min(1),
  status: z.enum(["cancelled", "not_found", "already_completed"]),
});
export type CancelOutcome = z.infer<typeof CancelOutcomeSchema>;

/** A live subagent with no backing job row, as wait and jobs results list it. */
export const AgentActivitySchema = z.looseObject({
  id: z.string().min(1),
  parentId: OptionalText,
  activity: OptionalText,
  ageMs: z.number().nonnegative(),
  live: z.boolean(),
  acceptedAt: z.number().optional(),
});
export type AgentActivity = z.infer<typeof AgentActivitySchema>;

/** The details of the coordination ops: `send`, `wait`, `jobs` and `cancel` (`CoordinationDetails`). */
export const CoordinationDetailsSchema = z.looseObject({
  ...ToolIdentitySchema.shape,
  op: OptionalText,
  meta: OpenRecord.optional(),
  from: OptionalText,
  to: OptionalText,
  receipts: z.array(IrcReceiptSchema).optional(),
  waited: IrcMessageSchema.nullable().optional(),
  jobs: z.array(JobSnapshotSchema).optional(),
  cancelled: z.array(CancelOutcomeSchema).optional(),
  agents: z.array(AgentActivitySchema).optional(),
  interrupted: z.boolean().optional(),
});
export type CoordinationDetails = z.infer<typeof CoordinationDetailsSchema>;

/** A launch daemon, as the launch ops (`start`, `stop`, `logs`) report it (`DaemonSnapshot`). */
export const DaemonSnapshotSchema = z.looseObject({
  name: z.string().min(1),
  id: OptionalText,
  state: z.enum(["starting", "running", "ready", "restarting", "stopping", "exited", "failed"]),
  exitCode: z.number().int().optional(),
  restartCount: z.number().int().nonnegative().optional(),
  outputBytes: z.number().nonnegative().optional(),
});
export type DaemonSnapshot = z.infer<typeof DaemonSnapshotSchema>;

/** One agent in the roster the `list` op returns. */
export const PeerSchema = z.looseObject({
  id: z.string().min(1),
  displayName: OptionalText,
  kind: OptionalText,
  status: z.string().min(1),
  parentId: OptionalText,
  unread: z.number().int().nonnegative().optional(),
  lastActivity: z.number().optional(),
});
export type Peer = z.infer<typeof PeerSchema>;

/** Hub results: the coordination ops, the roster (`list`) and the launch ops (`start`, `stop`, `logs`). */
export const HubDetailsSchema = z.looseObject({
  ...CoordinationDetailsSchema.shape,
  daemon: DaemonSnapshotSchema.optional(),
  timedOut: z.boolean().optional(),
  cursor: z.number().int().nonnegative().optional(),
  state: OptionalText,
  terminalRows: z.array(z.string()).optional(),
  peers: z.array(PeerSchema).optional(),
  counts: OpenRecord.optional(),
});
export type HubDetails = z.infer<typeof HubDetailsSchema>;

/** One subagent's live progress row, `AgentProgress`, as the task tool reports it while it runs. */
export const AgentProgressSchema = z.looseObject({
  index: z.number().int().nonnegative(),
  id: z.string().min(1),
  agent: z.string().min(1),
  agentSource: OptionalText,
  modelRole: OptionalText,
  status: z.enum(["pending", "running", "completed", "failed", "aborted"]),
  task: z.string().optional(),
  assignment: z.string().optional(),
  description: z.string().optional(),
  lastIntent: z.string().optional(),
  currentTool: OptionalText,
  currentToolArgs: z.string().optional(),
  recentOutput: z.array(z.string()).optional(),
  toolCount: z.number().int().nonnegative().optional(),
  requests: z.number().int().nonnegative().optional(),
  tokens: z.number().nonnegative().optional(),
  contextTokens: z.number().nonnegative().optional(),
  contextWindow: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  resolvedModel: OptionalText,
  resolvedModelIdentity: OptionalText,
  resolvedThinkingLevel: OptionalText,
  completionPercent: z.number().min(0).max(100).optional(),
});
export type AgentProgress = z.infer<typeof AgentProgressSchema>;

/** One finished subagent, `SingleResult`, as a task call that ran in the foreground returns it. */
export const TaskResultSchema = z.looseObject({
  index: z.number().int().nonnegative(),
  id: z.string().min(1),
  agent: z.string().min(1),
  agentSource: OptionalText,
  task: z.string().optional(),
  assignment: z.string().optional(),
  description: z.string().optional(),
  exitCode: z.number().int(),
  output: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
  tokens: z.number().nonnegative().optional(),
  error: OptionalText,
  aborted: z.boolean().optional(),
  abortReason: OptionalText,
  modelRole: OptionalText,
  resolvedModel: OptionalText,
  outputPath: OptionalText,
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

/** The task tool's details (`TaskToolDetails`): progress while agents run, results when they finish. */
export const TaskDetailsSchema = z.looseObject({
  ...ToolIdentitySchema.shape,
  projectAgentsDir: z.string().nullable().optional(),
  results: z.array(TaskResultSchema).optional(),
  totalDurationMs: z.number().nonnegative().optional(),
  progress: z.array(AgentProgressSchema).optional(),
  async: z
    .looseObject({
      state: z.enum(["running", "completed", "failed"]),
      jobId: z.string().min(1),
      type: z.string().min(1),
    })
    .optional(),
  usage: OpenRecord.optional(),
  outputPaths: z.array(z.string()).optional(),
});
export type TaskDetails = z.infer<typeof TaskDetailsSchema>;

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

/**
 * omp v18.8.9 yield details (`YieldDetails`, yield.ts:65-84; the result object at yield.ts:657-667). The output
 * wrapper adds `meta` (output-meta.ts:661). Synthetic results are not yields: omp writes them when a call was
 * skipped by a steering message or cut off by the provider (sessions: `__synthetic`, `source`, `executed`).
 */
export const YieldDetailsSchema = z.looseObject({
  ...ToolIdentitySchema.shape,
  data: z.unknown().optional(),
  status: z.enum(["success", "aborted"]).optional(),
  error: z.string().optional(),
  isError: z.boolean().optional(),
  type: z.union([z.string(), z.array(z.string())]).optional(),
  useLastTurn: z.boolean().optional(),
  complete: z.boolean().optional(),
  schemaOverridden: z.boolean().optional(),
  __synthetic: z.boolean().optional(),
  source: z.string().optional(),
  executed: z.boolean().optional(),
  upstreamError: z.string().optional(),
  __interrupted: z.boolean().optional(),
  execution: z.string().optional(),
  meta: OutputMetaSchema.optional(),
});
export type YieldDetails = z.infer<typeof YieldDetailsSchema>;

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
export function decodeWaitDetails(raw: unknown): T5DetailDecode<CoordinationDetails> {
  return decode(CoordinationDetailsSchema, raw, "wait");
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
