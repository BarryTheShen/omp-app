import { AppError, CapabilityKey, CapabilityStatus, type OmpCommandMap } from "@omp-app/contracts";
import { z } from "zod";

/**
 * D7's browser-visible execution slots. The names mirror the RPC/slash-mode inventory in
 * `research/modules/D7.md:15-23`; they are presentation slots, not claims of authoritative omp state.
 */
export const ExecutionMode = z.enum([
  "default",
  "browser",
  "computer",
  "extended-context",
  "fast",
  "force",
  "prewalk",
  "shake",
  "skillful",
  "slow",
  "vision",
]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

/** State is deliberately richer than a boolean because get_state lacks most mode objects. */
export const ModeStateKind = z.enum(["known", "requested", "fallback", "unavailable"]);
export type ModeStateKind = z.infer<typeof ModeStateKind>;

export const ModeScope = z.enum(["default", "settings", "session", "command"]);
export type ModeScope = z.infer<typeof ModeScope>;

export const ModeSource = z.enum(["omp-rpc", "omp-command", "config", "client", "upstream"]);
export type ModeSource = z.infer<typeof ModeSource>;

/** omp's usage-limit stage for the active model's account, as get_state reports it. Reset times are epoch seconds. */
export const UsageLimitStage = z.discriminatedUnion("stage", [
  z.strictObject({
    stage: z.literal("low_priority"),
    resetsAtSec: z.number().nonnegative(),
    allowanceLeftPercent: z.number().min(0).max(100).optional(),
  }),
  z.strictObject({
    stage: z.literal("wrap_up"),
    extraUsage: z.boolean(),
    resetsAtSec: z.number().nonnegative().optional(),
  }),
]);
export type UsageLimitStage = z.infer<typeof UsageLimitStage>;

export const ModeState = z
  .strictObject({
    mode: ExecutionMode,
    state: ModeStateKind,
    scope: ModeScope,
    source: ModeSource,
    requested: z.boolean().optional(),
    enabled: z.boolean().optional(),
    active: z.boolean().optional(),
    capability: CapabilityKey.optional(),
    reason: z.string().min(1).optional(),
    error: AppError.optional(),
    usageLimit: UsageLimitStage.optional(),
  })
  .superRefine((value, context) => {
    if (value.state === "unavailable" && value.reason === undefined && value.error === undefined) {
      context.addIssue({
        code: "custom",
        message: "unavailable mode state needs a reason or error",
      });
    }
  });
export type ModeState = z.infer<typeof ModeState>;

/** Fast has two intentionally separate values: configured/enabled and effective/provider-active. */
export const FastModeState = z.strictObject({
  enabled: z.boolean(),
  active: z.boolean(),
  state: ModeStateKind,
  /** The value the person asked for while omp has not answered that request yet. */
  requested: z.boolean().optional(),
  scope: ModeScope,
  source: ModeSource,
  capability: CapabilityKey.optional(),
  reason: z.string().min(1).optional(),
  error: AppError.optional(),
});
export type FastModeState = z.infer<typeof FastModeState>;

/**
 * A generic precedence candidate lets D8/P2 inject higher-priority slots without importing D7
 * internals. D7's own records additionally retain scope/source for its mode UI.
 */
export const PrecedenceCandidate = z.strictObject({
  slot: z.string().min(1),
  mode: z.string().min(1),
  priority: z.number().int().nonnegative(),
  state: ModeStateKind,
});
export type PrecedenceCandidate = z.infer<typeof PrecedenceCandidate>;

export const ModePrecedenceRecord = z.strictObject({
  slot: z.string().min(1),
  mode: ExecutionMode,
  scope: ModeScope,
  source: ModeSource,
  priority: z.number().int().nonnegative(),
  state: ModeStateKind,
});
export type ModePrecedenceRecord = z.infer<typeof ModePrecedenceRecord>;

export const ToolAvailabilityState = z.enum(["available", "fallback", "unavailable", "unknown"]);
export type ToolAvailabilityState = z.infer<typeof ToolAvailabilityState>;

export const ToolAvailability = z.strictObject({
  tool: z.string().min(1),
  state: ToolAvailabilityState,
  mode: ExecutionMode.optional(),
  capability: CapabilityKey.optional(),
  reason: z.string().min(1).optional(),
});
export type ToolAvailability = z.infer<typeof ToolAvailability>;

export const ModeSnapshot = z.strictObject({
  modes: z.partialRecord(ExecutionMode, ModeState),
  fast: FastModeState,
  precedence: z.array(ModePrecedenceRecord),
  tools: z.array(ToolAvailability),
  revision: z.number().int().nonnegative(),
});
export type ModeSnapshot = z.infer<typeof ModeSnapshot>;

export const ModeRequest = z.strictObject({
  mode: ExecutionMode,
  scope: ModeScope,
  requested: z.boolean().default(true),
});

export type ModeRequest = z.infer<typeof ModeRequest>;
/** Action/state capability requirements; an absent C0 key is never treated as available. */
export const MODE_CAPABILITY_REQUIREMENTS: Readonly<
  Record<ExecutionMode, readonly CapabilityKey[]>
> = {
  default: [],
  browser: ["host.command-gateway"],
  computer: ["host.command-gateway"],
  "extended-context": ["host.command-gateway"],
  fast: ["omp.cmd.set_fast_mode", "omp.cmd.get_state"],
  force: ["host.command-gateway"],
  prewalk: ["host.command-gateway"],
  shake: ["host.command-gateway"],
  skillful: ["host.command-gateway"],
  slow: ["omp.cmd.set_slow_mode", "omp.cmd.get_state"],
  vision: ["host.command-gateway"],
};

export const ModeCommandResult = z.strictObject({
  ok: z.boolean(),
  command: z.string().min(1),
  mode: ExecutionMode,
  state: ModeStateKind,
  reason: z.string().min(1).optional(),
  capability: CapabilityKey.optional(),
  error: AppError.optional(),
});
export type ModeCommandResult = z.infer<typeof ModeCommandResult>;

export const D7_AP6_CAPABILITY = "upstream.execution-mode-state" as const;
export const D7_AP6_REASON = "The app cannot read this setting from omp yet.";

/** Capability gates from the D7 research row; absent keys are treated as unavailable by C0. */
export const D7_CAPABILITIES = [
  "host.command-gateway",
  "omp.cmd.get_available_commands",
  "omp.cmd.get_state",
  "omp.cmd.prompt",
  "omp.cmd.set_fast_mode",
  "omp.cmd.set_slow_mode",
  D7_AP6_CAPABILITY,
] as const satisfies readonly CapabilityKey[];
export type D7Capability = (typeof D7_CAPABILITIES)[number];
export const D7CapabilityStatus = z.partialRecord(z.enum(D7_CAPABILITIES), CapabilityStatus);
export type D7CapabilityStatus = z.infer<typeof D7CapabilityStatus>;

export type D7StateRpcCommand = "get_state" | "set_fast_mode" | "set_slow_mode";
export type D7StateRpcResults = Pick<OmpCommandMap, D7StateRpcCommand>;
export type GetStateResult = OmpCommandMap["get_state"]["result"];
export type SetFastModeResult = OmpCommandMap["set_fast_mode"]["result"];
