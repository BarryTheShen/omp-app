import type { CapabilityStatus } from "@omp-app/contracts";
import {
  MODEL_SCOPE_AP6_CAPABILITY,
  MODEL_SCOPE_AP6_REASON,
  type ModelCapabilities,
  type ModelCapability,
  ModelScope,
  type ModelScopeAvailability,
  type ModelScope as ModelScopeValue,
} from "./models";

/** Returns the visible capability gate for a scope; this reply is never emulated by set/restore. */
export function modelScopeAvailability(
  scope: ModelScopeValue,
  capabilities: ModelCapabilities,
): ModelScopeAvailability {
  const capability =
    scope === "reply"
      ? MODEL_SCOPE_AP6_CAPABILITY
      : scope === "session"
        ? "omp.cmd.set_model"
        : "host.config";
  const status: CapabilityStatus | undefined = capabilities[capability as ModelCapability];
  if (status?.state === "available") {
    return { state: "available", scope, ...(capability ? { capability } : {}) };
  }
  return {
    state: "unavailable",
    scope,
    capability,
    reason:
      scope === "reply" ? MODEL_SCOPE_AP6_REASON : (status?.detail ?? "Capability is unavailable."),
  };
}

/** Product defaults used before the capability map arrives: reply is visibly unavailable. */
export const DEFAULT_MODEL_SCOPE_AVAILABILITY: readonly ModelScopeAvailability[] = [
  {
    state: "unavailable",
    scope: "reply",
    capability: MODEL_SCOPE_AP6_CAPABILITY,
    reason: MODEL_SCOPE_AP6_REASON,
  },
  {
    state: "unavailable",
    scope: "session",
    capability: "omp.cmd.set_model",
    reason: "Capability is unavailable.",
  },
  {
    state: "unavailable",
    scope: "default",
    capability: "host.config",
    reason: "Capability is unavailable.",
  },
];

export { ModelScope };
