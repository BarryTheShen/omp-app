import type { CapabilityKey, CapabilityMap } from "@omp-app/contracts";
import {
  D7_AP6_CAPABILITY,
  D7_AP6_REASON,
  type ExecutionMode,
  MODE_CAPABILITY_REQUIREMENTS,
  ModePrecedenceRecord,
  type ModeScope as ModeScopeValue,
  type ModeSource,
  ModeState,
  type ModeStateKind,
  type ModeState as ModeStateValue,
  PrecedenceCandidate,
  type PrecedenceCandidate as PrecedenceCandidateValue,
  type ToolAvailability,
} from "./models";

/** Higher-priority sources win without silently merging conflicting mode slots. */
export const MODE_SCOPE_PRIORITY: Readonly<Record<ModeScopeValue, number>> = {
  default: 1,
  settings: 2,
  session: 3,
  command: 4,
};

export function modeCapability(mode: ExecutionMode): CapabilityKey | undefined {
  return MODE_CAPABILITY_REQUIREMENTS[mode][0];
}

export function capabilityAvailable(
  capabilities: CapabilityMap,
  capability: CapabilityKey | undefined,
): boolean {
  if (capability === undefined) return true;
  return (
    capabilities[capability]?.state === "available" ||
    capabilities[capability]?.state === "fallback"
  );
}

export function unavailableMode(
  mode: ExecutionMode,
  scope: ModeScopeValue,
  source: ModeSource,
  reason?: string,
): ModeStateValue {
  const capability =
    mode === "prewalk" || mode === "extended-context" ? D7_AP6_CAPABILITY : modeCapability(mode);
  return ModeState.parse({
    mode,
    state: "unavailable",
    scope,
    source,
    capability,
    reason:
      reason ?? (capability === D7_AP6_CAPABILITY ? D7_AP6_REASON : "The mode is unavailable."),
  });
}

/** Pure sorting seam for D8/P2 records that have a higher priority than D7's own slots. */
export function resolvePrecedence(
  candidates: readonly PrecedenceCandidateValue[],
): readonly PrecedenceCandidateValue[] {
  return candidates
    .map((candidate) => PrecedenceCandidate.parse(candidate))
    .sort((left, right) => right.priority - left.priority || left.slot.localeCompare(right.slot));
}

/**
 * Selects effective status by source precedence. Unknown/fallback/requested states remain in the
 * returned records so the UI can explain why a mode is not authoritative instead of reducing it
 * to false.
 */
export function resolveModePrecedence(
  states: readonly ModeStateValue[],
): readonly ModePrecedenceRecord[] {
  return states
    .map((state) =>
      ModePrecedenceRecord.parse({
        slot: "d7",
        mode: state.mode,
        scope: state.scope,
        source: state.source,
        priority: MODE_SCOPE_PRIORITY[state.scope],
        state: state.state,
      }),
    )
    .sort((left, right) => right.priority - left.priority || left.mode.localeCompare(right.mode));
}

export function effectiveModeState(
  states: readonly ModeStateValue[],
  mode: ExecutionMode,
): ModeStateValue | undefined {
  return [...states]
    .filter((state) => state.mode === mode)
    .sort((left, right) => MODE_SCOPE_PRIORITY[right.scope] - MODE_SCOPE_PRIORITY[left.scope])[0];
}

export function modeState(
  mode: ExecutionMode,
  scope: ModeScopeValue,
  source: ModeSource,
  state: ModeStateKind,
  capabilities: CapabilityMap,
  details: Pick<ModeStateValue, "enabled" | "active" | "requested" | "reason" | "error"> = {},
): ModeStateValue {
  const capability = modeCapability(mode);
  if (!capabilityAvailable(capabilities, capability)) {
    return unavailableMode(mode, scope, source, details.reason);
  }
  const capabilityState = capability === undefined ? undefined : capabilities[capability]?.state;
  const resolvedState = capabilityState === "fallback" ? "fallback" : state;
  return ModeState.parse({
    mode,
    scope,
    source,
    state: resolvedState,
    ...(capability ? { capability } : {}),
    ...details,
  });
}

export function toolAvailability(
  tool: string,
  capabilities: CapabilityMap,
  options: {
    readonly capability?: CapabilityKey;
    readonly mode?: ExecutionMode;
    readonly fallbackReason?: string;
  } = {},
): ToolAvailability {
  const capability = options.capability;
  const status = capability === undefined ? undefined : capabilities[capability];
  if (status?.state === "available") {
    return {
      tool,
      state: "available",
      ...(options.mode ? { mode: options.mode } : {}),
      ...(capability ? { capability } : {}),
    };
  }
  if (status?.state === "fallback") {
    return {
      tool,
      state: "fallback",
      ...(options.mode ? { mode: options.mode } : {}),
      ...(capability ? { capability } : {}),
      reason: status.detail ?? options.fallbackReason ?? "The host fallback is limited.",
    };
  }
  if (capability === undefined) return { tool, state: "unknown" };
  return {
    tool,
    state: "unavailable",
    ...(options.mode ? { mode: options.mode } : {}),
    capability,
    reason: status?.detail ?? options.fallbackReason ?? "The required capability is unavailable.",
  };
}
