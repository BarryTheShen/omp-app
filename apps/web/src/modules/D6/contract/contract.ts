import type { CapabilityKey, PortCallOptions, ThreadId } from "@omp-app/contracts";
import { AppError as AppErrorSchema, checkScrubbed } from "@omp-app/contracts";
import { z } from "zod";

export const DiagnosticCommandNameSchema = z.enum(["changelog", "jobs", "security", "trace"]);
export type DiagnosticCommandName = z.infer<typeof DiagnosticCommandNameSchema>;

export const DiagnosticCommandRequestSchema = z.strictObject({
  name: DiagnosticCommandNameSchema,
  args: z.string().max(4_096).optional(),
});
export type DiagnosticCommandRequest = z.infer<typeof DiagnosticCommandRequestSchema>;

export const RedactedReportLineSchema = z.strictObject({
  text: z.string().max(4_096),
  level: z.enum(["info", "warning", "error"]).default("info"),
  redacted: z.boolean(),
});
export type RedactedReportLine = z.infer<typeof RedactedReportLineSchema>;

export const DiagnosticCommandResultSchema = z.strictObject({
  command: DiagnosticCommandNameSchema,
  status: z.enum(["completed", "aborted", "error"]),
  lines: z.array(RedactedReportLineSchema).max(500),
  promptSettled: z.boolean(),
  sessionSettled: z.boolean(),
  safeUrl: z.string().url().optional(),
  requestId: z.string().min(1).optional(),
  truncated: z.boolean(),
});
export type DiagnosticCommandResult = z.infer<typeof DiagnosticCommandResultSchema>;

export interface DiagnosticCommandPort {
  run(
    threadId: ThreadId,
    request: DiagnosticCommandRequest,
    options?: PortCallOptions,
  ): Promise<DiagnosticCommandResult>;
  cancel(threadId: ThreadId, requestId: string, options?: PortCallOptions): Promise<void>;
}

export const D6_COMMAND_CAPABILITIES = {
  changelog: "host.command-gateway",
  jobs: "host.command-gateway",
  security: "host.command-gateway",
  trace: "host.command-gateway",
} as const satisfies Record<DiagnosticCommandName, CapabilityKey>;

export function diagnosticSlashCommand(request: DiagnosticCommandRequest): string {
  return request.args === undefined || request.args.trim() === ""
    ? `/${request.name}`
    : `/${request.name} ${request.args.trim()}`;
}

export const SidePanelDescriptorSchema = z.strictObject({
  kind: z.literal("panel"),
  id: z.string().regex(/^D6\.[A-Za-z0-9_.-]+$/),
  owner: z.literal("D6"),
  title: z.string().min(1),
  covers: z.array(z.string().min(1)).min(1),
  requires: z.array(z.string().min(1)),
  position: z.enum(["left", "right", "inline"]),
  readOnly: z.boolean(),
});
export type SidePanelDescriptor = z.infer<typeof SidePanelDescriptorSchema>;

export const SecurityFindingSchema = z.strictObject({
  id: z.string().min(1),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  title: z.string().min(1),
  summary: z.string().max(4_096),
  status: z.enum(["open", "resolved", "ignored", "unknown"]),
  scanId: z.string().min(1).optional(),
});
export type SecurityFinding = z.infer<typeof SecurityFindingSchema>;

export const SecurityScanStatusSchema = z.strictObject({
  scanId: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  findings: z.array(SecurityFindingSchema),
  startedAt: z.number().finite().optional(),
  finishedAt: z.number().finite().optional(),
  error: AppErrorSchema.optional(),
});
export type SecurityScanStatus = z.infer<typeof SecurityScanStatusSchema>;

export const JobSummarySchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "unknown"]),
  durationMs: z.number().finite().nonnegative().optional(),
  output: z.array(RedactedReportLineSchema),
  stale: z.boolean(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

export const CleanseProgressSchema = z.strictObject({
  status: z.enum(["idle", "checking", "running", "completed", "failed", "cancelled", "unknown"]),
  wave: z.number().int().nonnegative().optional(),
  totalWaves: z.number().int().positive().optional(),
  agentIds: z.array(z.string().min(1)),
  progress: z.number().finite().min(0).max(1).optional(),
  message: z.string().max(4_096).optional(),
});
export type CleanseProgress = z.infer<typeof CleanseProgressSchema>;

export const PauseGateSnapshotSchema = z.strictObject({
  open: z.boolean(),
  openedAt: z.number().finite().nullable(),
  elapsedMs: z.number().finite().nonnegative(),
  authoritative: z.literal(false),
  reason: z.string().min(1),
});
export type PauseGateSnapshot = z.infer<typeof PauseGateSnapshotSchema>;

export interface PauseGate {
  getSnapshot(): PauseGateSnapshot;
  subscribe(listener: (snapshot: PauseGateSnapshot) => void): () => void;
  open(reason?: string): void;
  resume(): void;
}

export class LocalPauseGate implements PauseGate {
  private readonly listeners = new Set<(snapshot: PauseGateSnapshot) => void>();
  private readonly now: () => number;
  private openedAt: number | null = null;
  private reason = "Paused locally; omp work is not claimed to be frozen.";

  public constructor(now: () => number = Date.now) {
    this.now = now;
  }

  public getSnapshot(): PauseGateSnapshot {
    const openedAt = this.openedAt;
    return {
      open: openedAt !== null,
      openedAt,
      elapsedMs: openedAt === null ? 0 : Math.max(0, this.now() - openedAt),
      authoritative: false,
      reason: this.reason,
    };
  }

  public subscribe(listener: (snapshot: PauseGateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public open(reason = this.reason): void {
    this.reason = reason;
    this.openedAt ??= this.now();
    this.emit();
  }

  public resume(): void {
    this.openedAt = null;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export const RecoveryActionKindSchema = z.enum([
  "retry",
  "reconnect",
  "refetch",
  "clear-local",
  "dismiss",
]);
export type RecoveryActionKind = z.infer<typeof RecoveryActionKindSchema>;

export const RecoveryActionSchema = z.strictObject({
  id: z.string().min(1),
  kind: RecoveryActionKindSchema,
  label: z.string().min(1),
  availability: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("available") }),
    z.strictObject({
      state: z.literal("unavailable"),
      capability: z.string().min(1).optional(),
      reason: z.string().min(1),
    }),
  ]),
});
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const RecoveryActionResultSchema = z.strictObject({
  actionId: z.string().min(1),
  status: z.enum(["completed", "unavailable", "failed"]),
  error: AppErrorSchema.optional(),
});
export type RecoveryActionResult = z.infer<typeof RecoveryActionResultSchema>;

const REDACTION_PATTERNS: readonly [RegExp, string][] = [
  [/(?:Bearer\s+)(?!<REDACTED:)[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <REDACTED:TOKEN>"],
  [/\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g, "<REDACTED:KEY>"],
  [/(?:\/home|\/Users|\/root|\/tmp|\/var\/tmp|\/private\/tmp)(?:\/[^\s"'`]+)*/g, "<REDACTED:PATH>"],
  // omp's /trace prints its session path inside a link, percent-encoded (encodeURIComponent turns "/" into "%2F").
  [/%2F(?:home|Users|root|tmp|var%2Ftmp|private%2Ftmp)[^\s"'`&]*/gi, "<REDACTED:PATH>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<REDACTED:EMAIL>"],
];

export function redactDiagnosticText(
  text: string,
  maxLength = 4_096,
): {
  readonly text: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
} {
  let next = text;
  let redacted = false;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    const replaced = next.replace(pattern, replacement);
    redacted ||= replaced !== next;
    next = replaced;
  }
  const truncated = next.length > maxLength;
  return {
    text: truncated ? `${next.slice(0, Math.max(0, maxLength - 1))}…` : next,
    redacted,
    truncated,
  };
}

export function redactDiagnosticLines(
  lines: readonly { readonly text: string; readonly level?: "info" | "warning" | "error" }[],
  maxLines = 200,
): { readonly lines: readonly RedactedReportLine[]; readonly truncated: boolean } {
  const selected = lines.slice(0, maxLines);
  const result = selected.map((line) => {
    const safe = redactDiagnosticText(line.text);
    return RedactedReportLineSchema.parse({
      text: safe.text,
      level: line.level ?? "info",
      redacted: safe.redacted,
    });
  });
  return {
    lines: result,
    truncated: lines.length > maxLines || result.some((line) => line.text.endsWith("…")),
  };
}

/** C0 scrub is a final assertion for generated DTOs; this never exposes the unsafe source text. */
export function isScrubbedDiagnosticText(text: string): boolean {
  return checkScrubbed(text).length === 0;
}
