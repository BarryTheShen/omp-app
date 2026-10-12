import { NoticeSeverity, ThreadId } from "@omp-app/contracts";
import { z } from "zod";

const NonEmptyText = z.string().min(1);

export const AutoRetryStartSchema = z.strictObject({
  type: z.literal("auto_retry_start"),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  delayMs: z.number().finite().nonnegative(),
  errorMessage: z.string(),
  errorId: z.number().int().nonnegative().optional(),
});
export type AutoRetryStart = z.infer<typeof AutoRetryStartSchema>;

export const AutoRetryEndSchema = z.strictObject({
  type: z.literal("auto_retry_end"),
  success: z.boolean(),
  attempt: z.number().int().nonnegative(),
  finalError: z.string().optional(),
  /** Provider-specific retry records intentionally remain open data. */
  retryErrors: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type AutoRetryEnd = z.infer<typeof AutoRetryEndSchema>;

export const RetryFallbackAppliedSchema = z.strictObject({
  type: z.literal("retry_fallback_applied"),
  from: NonEmptyText,
  to: NonEmptyText,
  role: NonEmptyText,
  reason: z.string().optional(),
});
export type RetryFallbackApplied = z.infer<typeof RetryFallbackAppliedSchema>;

export const RetryFallbackSucceededSchema = z.strictObject({
  type: z.literal("retry_fallback_succeeded"),
  model: NonEmptyText,
  role: NonEmptyText,
});
export type RetryFallbackSucceeded = z.infer<typeof RetryFallbackSucceededSchema>;

/** TTSR rule fields are extension-defined and stay open; N1 renders them as untrusted text. */
export const TtsrTriggeredSchema = z.strictObject({
  type: z.literal("ttsr_triggered"),
  rules: z.array(z.record(z.string(), z.unknown())),
});
export type TtsrTriggered = z.infer<typeof TtsrTriggeredSchema>;

export const TodoStatus = z.enum(["pending", "in_progress", "completed", "abandoned", "blocked"]);
export type TodoStatus = z.infer<typeof TodoStatus>;

export const TodoItemSchema = z.strictObject({
  content: z.string(),
  status: TodoStatus,
  blocker: z.string().optional(),
  details: z.string().optional(),
  notes: z.array(z.string()).optional(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoReminderSchema = z.strictObject({
  type: z.literal("todo_reminder"),
  todos: z.array(TodoItemSchema),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
});
export const TodoAutoClearSchema = z.strictObject({
  type: z.literal("todo_auto_clear"),
});

export const SessionNoticeSchema = z.strictObject({
  type: z.literal("notice"),
  level: z.enum(["info", "warning", "error"]),
  message: z.string(),
  source: z.string().optional(),
});
export type SessionNotice = z.infer<typeof SessionNoticeSchema>;

/** The R0 event subset projected by N1; rule/retry detail records remain open data. */
export const N1RuntimeEventSchema = z.discriminatedUnion("type", [
  AutoRetryStartSchema,
  AutoRetryEndSchema,
  RetryFallbackAppliedSchema,
  RetryFallbackSucceededSchema,
  TtsrTriggeredSchema,
  TodoAutoClearSchema,
  SessionNoticeSchema,
]);
export type N1RuntimeEvent = z.infer<typeof N1RuntimeEventSchema>;

/** `quiet`: an informational notice, collapsed into the omp notices line and never read aloud. */
export const NotificationPlacement = z.enum(["transcript", "toast", "banner", "inline", "quiet"]);
export type NotificationPlacement = z.infer<typeof NotificationPlacement>;

export const LiveRegionPolicy = z.enum(["off", "polite", "assertive"]);
export type LiveRegionPolicy = z.infer<typeof LiveRegionPolicy>;

/** Immutable notice data shared by N1's bus and its transcript/toast/banner projections. */
export const Notification = z.strictObject({
  threadId: ThreadId,
  dedupeKey: NonEmptyText,
  severity: NoticeSeverity,
  placement: NotificationPlacement,
  message: z.string(),
  source: z.string().optional(),
  expiresAt: z.number().finite().nonnegative().optional(),
  live: LiveRegionPolicy,
  focus: z.literal("preserve"),
});
export type Notification = z.infer<typeof Notification>;

export const StatusSegmentAvailability = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("available"),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.strictObject({ state: z.literal("unavailable"), reason: NonEmptyText }),
]);
export type StatusSegmentAvailability = z.infer<typeof StatusSegmentAvailability>;

/** A status value always carries an accessible label and an explicit unavailable state. */
export const StatusSegment = z.strictObject({
  id: NonEmptyText,
  label: NonEmptyText,
  accessibleLabel: NonEmptyText,
  value: StatusSegmentAvailability,
});
export type StatusSegment = z.infer<typeof StatusSegment>;

export type { PresentationHandoff } from "../../U4/contract";
