import type { CapabilityKey, OmpWire, ThreadId } from "@omp-app/contracts";
import { AppError as AppErrorSchema } from "@omp-app/contracts";
import { z } from "zod";

export const P7_CAPABILITIES = [
  "omp.cmd.get_state",
  "omp.cmd.get_session_stats",
  "omp.cmd.compact",
  "omp.cmd.set_auto_compaction",
  "host.command-gateway",
  "host.config",
] as const satisfies readonly CapabilityKey[];
export type P7Capability = (typeof P7_CAPABILITIES)[number];

export const ContextUsage = z.strictObject({
  tokens: z.number().int().nonnegative(),
  contextWindow: z.number().int().positive(),
  /**
   * Can pass 100: a session can hold more than its model's window (after switching to a smaller
   * model, or just before auto-compaction). Rejecting it threw while rendering and blanked the page.
   */
  percent: z.number().finite().min(0),
});
export type ContextUsage = z.infer<typeof ContextUsage>;

export const ContextUsageState = z.strictObject({
  /** `null` means omp did not expose context usage; it is never treated as zero. */
  usage: ContextUsage.nullable(),
  isCompacting: z.boolean(),
  autoCompactionEnabled: z.boolean().nullable(),
  tokensPerSecond: z.number().finite().nonnegative().nullable(),
  revision: z.string().min(1),
  error: AppErrorSchema.nullable(),
});
export type ContextUsageState = z.infer<typeof ContextUsageState>;

export const UsageTotals = z.strictObject({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative().nullable(),
  cost: z.number().finite().nonnegative(),
  premiumRequests: z.number().int().nonnegative().nullable(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const PerTurnUsage = z.strictObject({
  timestamp: z.number().finite(),
  durationMs: z.number().finite().nonnegative().nullable(),
  timeToFirstTokenMs: z.number().finite().nonnegative().nullable(),
  usage: UsageTotals,
});
export type PerTurnUsage = z.infer<typeof PerTurnUsage>;

export const UsageSnapshot = z.strictObject({
  sessionId: z.string().min(1),
  status: z.enum(["idle", "loading", "ready", "error"]),
  totals: UsageTotals.nullable(),
  contextUsage: ContextUsage.nullable(),
  tokenRate: z.number().finite().nonnegative().nullable(),
  lastTurn: PerTurnUsage.nullable(),
  revision: z.string().min(1),
  error: AppErrorSchema.nullable(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

export const CompactionMethod = z.enum([
  "manual",
  "threshold",
  "overflow",
  "idle",
  "incomplete",
  "remote",
  "handoff",
  "shake",
  "snapcompact",
]);
export type CompactionMethod = z.infer<typeof CompactionMethod>;

export const CompactionPhase = z.enum([
  "idle",
  "running",
  "completed",
  "skipped",
  "aborted",
  "error",
]);
export type CompactionPhase = z.infer<typeof CompactionPhase>;

export const CompactionState = z.strictObject({
  phase: CompactionPhase,
  method: CompactionMethod.nullable(),
  auto: z.boolean(),
  result: z.custom<OmpWire.CompactionResult>().nullable(),
  error: AppErrorSchema.nullable(),
  revision: z.string().min(1),
});
export type CompactionState = z.infer<typeof CompactionState>;

export const CompactRequest = z.strictObject({
  customInstructions: z.string().optional(),
});
export type CompactRequest = z.infer<typeof CompactRequest>;

export const AutoCompactionRequest = z.strictObject({ enabled: z.boolean() });
export type AutoCompactionRequest = z.infer<typeof AutoCompactionRequest>;

export const ContextUsageAvailability = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("available"), usage: ContextUsage }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.string().min(1),
    capability: z.string().min(1),
  }),
]);
export type ContextUsageAvailability = z.infer<typeof ContextUsageAvailability>;

export type SessionContextProjection = {
  readonly threadId: ThreadId;
  readonly contextUsage?: OmpWire.ContextUsage;
  readonly isCompacting?: boolean;
  readonly autoCompactionEnabled?: boolean;
  readonly tokensPerSecond?: number | null;
  readonly revision: string;
};
