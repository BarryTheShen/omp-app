import { AppFailure, type CapabilityKey } from "@omp-app/contracts";
import { z } from "zod";

const UnknownRecord = z.record(z.string(), z.unknown());
const OptionalText = z.string().optional();

export const HostToolStatusSchema = z.enum([
  "registered",
  "running",
  "partial",
  "success",
  "error",
  "cancelled",
  "unavailable",
]);
export type HostToolStatus = z.infer<typeof HostToolStatusSchema>;
export const HostToolModelSchema = z.looseObject({
  id: OptionalText,
  toolCallId: OptionalText,
  toolName: OptionalText,
  status: HostToolStatusSchema.optional(),
  partialResult: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type HostToolModel = z.infer<typeof HostToolModelSchema>;

export const HostUriStatusSchema = z.enum([
  "pending",
  "reading",
  "writing",
  "success",
  "error",
  "cancelled",
  "unavailable",
]);
export type HostUriStatus = z.infer<typeof HostUriStatusSchema>;
export const HostUriModelSchema = z.looseObject({
  id: OptionalText,
  targetId: OptionalText,
  operation: z.enum(["read", "write"]).optional(),
  url: OptionalText,
  status: HostUriStatusSchema.optional(),
  contentType: OptionalText,
  immutable: z.boolean().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type HostUriModel = z.infer<typeof HostUriModelSchema>;

export const ResolveDetailsSchema = z.looseObject({
  action: z.enum(["apply", "discard"]).optional(),
  reason: OptionalText,
  sourceToolName: OptionalText,
  label: OptionalText,
  sourceResultDetails: UnknownRecord.optional(),
});
export type ResolveDetails = z.infer<typeof ResolveDetailsSchema>;

export const CheckpointDetailsSchema = z.looseObject({
  goal: OptionalText,
  startedAt: OptionalText,
  meta: UnknownRecord.optional(),
});
export type CheckpointDetails = z.infer<typeof CheckpointDetailsSchema>;
export const RewindDetailsSchema = z.looseObject({
  report: OptionalText,
  rewound: z.boolean().optional(),
  meta: UnknownRecord.optional(),
});
export type RewindDetails = z.infer<typeof RewindDetailsSchema>;

/**
 * omp v18.6.1 goal tool details: packages/tui/src/tools/goal.ts:13-33 (`Goal`, `GoalToolDetails`),
 * built in packages/coding-agent/src/goals/tools/goal-tool.ts:115-120. Objective, status and token
 * counts live inside `goal`; `goal`, `remainingTokens` and `completionBudgetReport` may be null.
 */
const GoalRecordSchema = z.looseObject({
  id: OptionalText,
  objective: OptionalText,
  status: z.enum(["active", "paused", "budget-limited", "complete", "dropped"]).optional(),
  tokenBudget: z.number().nonnegative().optional(),
  tokensUsed: z.number().nonnegative().optional(),
  timeUsedSeconds: z.number().nonnegative().optional(),
});
export const GoalDetailsSchema = z.looseObject({
  op: z.enum(["create", "get", "complete", "resume", "drop"]).optional(),
  goal: GoalRecordSchema.nullable().optional(),
  remainingTokens: z.number().nonnegative().nullable().optional(),
  completionBudgetReport: z.string().nullable().optional(),
  /** Not sent by omp v18.6.1 (failures arrive as tool errors); shown when a host supplies one. */
  error: UnknownRecord.optional(),
});
export type GoalDetails = z.infer<typeof GoalDetailsSchema>;

const SecurityActionSchema = z.enum([
  "preflight",
  "start",
  "status",
  "cancel",
  "validate",
  "cloud_scans",
  "cloud_start",
  "cloud_status",
  "cloud_pull",
]);
const SecurityValidationStatusSchema = z.enum([
  "unvalidated",
  "validated",
  "rejected",
  "partial",
  "error",
]);
const SeverityCount = z.number().nonnegative().optional();

/** omp v18.6.1 security_scan arguments: packages/coding-agent/src/tools/security-scan.ts:21-45. */
export const SecurityScanArgsSchema = z.looseObject({
  action: SecurityActionSchema.optional(),
  target_kind: z.enum(["repository", "scoped_path", "ref_diff", "working_tree"]).optional(),
  include_paths: z.array(z.string()).optional(),
  base_revision: OptionalText,
  head_revision: OptionalText,
  finding_id: OptionalText,
  repository_url: OptionalText,
});
export type SecurityScanArgs = z.infer<typeof SecurityScanArgsSchema>;

/**
 * omp v18.6.1 security_scan details: packages/coding-agent/src/tools/security-scan.ts:49-59
 * (`SecurityScanToolDetails`). `operation` is the coordinator snapshot
 * (packages/coding-agent/src/security/coordinator.ts:56-77); cloud shapes come from
 * packages/coding-agent/src/security/cloud.ts:49-62 and :81-92. The result carries no
 * per-finding rows; failures arrive as tool errors.
 */
export const SecurityScanDetailsSchema = z.looseObject({
  action: SecurityActionSchema.optional(),
  plan: z.looseObject({ id: OptionalText, fingerprint: OptionalText }).optional(),
  operation: z
    .looseObject({
      operationId: OptionalText,
      planId: OptionalText,
      scanId: OptionalText,
      phase: z
        .enum([
          "queued",
          "preparing",
          "reviewing",
          "publishing",
          "completed",
          "partial",
          "cancelled",
          "failed",
        ])
        .optional(),
      findingCount: z.number().nonnegative().optional(),
      error: OptionalText,
    })
    .optional(),
  cancelled: z.boolean().optional(),
  finding: z
    .looseObject({ id: OptionalText, validationStatus: SecurityValidationStatusSchema.optional() })
    .optional(),
  cloudConfigurations: z
    .array(
      z.looseObject({
        id: OptionalText,
        repositoryUrl: OptionalText,
        currentStep: OptionalText,
        state: OptionalText,
      }),
    )
    .optional(),
  cloudStats: z
    .looseObject({
      configurationId: OptionalText,
      currentStep: OptionalText,
      pendingCommits: z.number().nonnegative().optional(),
      finishedCommits: z.number().nonnegative().optional(),
      failedCommits: z.number().nonnegative().optional(),
      findingCounts: z
        .looseObject({
          critical: SeverityCount,
          high: SeverityCount,
          medium: SeverityCount,
          low: SeverityCount,
          informational: SeverityCount,
        })
        .optional(),
    })
    .optional(),
  cloudScan: z.looseObject({ id: OptionalText, repositoryUrl: OptionalText }).optional(),
  importedScan: z
    .looseObject({ id: OptionalText, findingCount: z.number().nonnegative().optional() })
    .optional(),
});
export type SecurityScanDetails = z.infer<typeof SecurityScanDetailsSchema>;

export const ThinkDetailsSchema = z.looseObject({
  recorded: z.boolean().optional(),
  status: z.enum(["recorded", "completed", "error"]).optional(),
  error: UnknownRecord.optional(),
});
export type ThinkDetails = z.infer<typeof ThinkDetailsSchema>;

export type T7DetailDecode<T> =
  | { readonly ok: true; readonly value: T; readonly raw: unknown }
  | { readonly ok: false; readonly error: AppFailure; readonly raw: unknown };

function decode<T>(schema: z.ZodType<T>, raw: unknown, label: string): T7DetailDecode<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data, raw };
  return {
    ok: false,
    error: new AppFailure({
      code: "invalid_args",
      message: `Malformed ${label}; showing raw details.`,
      retryable: false,
    }),
    raw,
  };
}

export const decodeHostTool = (raw: unknown): T7DetailDecode<HostToolModel> =>
  decode(HostToolModelSchema, raw, "host tool details");
export const decodeHostUri = (raw: unknown): T7DetailDecode<HostUriModel> =>
  decode(HostUriModelSchema, raw, "host URI details");
export const decodeResolve = (raw: unknown): T7DetailDecode<ResolveDetails> =>
  decode(ResolveDetailsSchema, raw, "resolve details");
export const decodeCheckpoint = (raw: unknown): T7DetailDecode<CheckpointDetails> =>
  decode(CheckpointDetailsSchema, raw, "checkpoint details");
export const decodeRewind = (raw: unknown): T7DetailDecode<RewindDetails> =>
  decode(RewindDetailsSchema, raw, "rewind details");
export const decodeGoal = (raw: unknown): T7DetailDecode<GoalDetails> =>
  decode(GoalDetailsSchema, raw, "goal details");
export const decodeSecurityScan = (raw: unknown): T7DetailDecode<SecurityScanDetails> =>
  decode(SecurityScanDetailsSchema, raw, "security scan details");
export const decodeSecurityScanArgs = (raw: unknown): T7DetailDecode<SecurityScanArgs> =>
  decode(SecurityScanArgsSchema, raw, "security scan arguments");
export const decodeThink = (raw: unknown): T7DetailDecode<ThinkDetails> =>
  decode(ThinkDetailsSchema, raw, "think details");

const CAPABILITY_BY_TOOL: Readonly<Record<string, CapabilityKey>> = {
  host_tool: "omp.host-tools",
  host_uri: "omp.host-uris",
  security_scan: "upstream.security-scan",
  goal: "upstream.goal",
  checkpoint: "host.checkpoints",
  rewind: "host.checkpoints",
};

export function capabilityForT7Tool(toolName: string): CapabilityKey | undefined {
  return CAPABILITY_BY_TOOL[toolName];
}

export function unavailableForT7Tool(toolName: string): AppFailure {
  const capability = capabilityForT7Tool(toolName);
  return new AppFailure({
    code: "unavailable",
    message:
      capability === undefined
        ? "This recorded tool action is unavailable."
        : `${capability} is unavailable for this runtime.`,
    retryable: false,
    ...(capability === undefined ? {} : { capability }),
  });
}

/** Never echoes arbitrary result/error text; renderers may show the raw slot separately. */
export function safeToolError(
  value: unknown,
  fallback = "The tool reported an error.",
): {
  readonly code?: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (value instanceof AppFailure)
    return { code: value.appError.code, message: fallback, retryable: value.appError.retryable };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const code = "code" in value && typeof value.code === "string" ? value.code : undefined;
    const retryable = "retryable" in value && value.retryable === true;
    return { ...(code === undefined ? {} : { code }), message: fallback, retryable };
  }
  return { message: fallback, retryable: false };
}
