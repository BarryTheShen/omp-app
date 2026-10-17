import type { CapabilityMap, RestoreOperation } from "@omp-app/contracts";
import { assertGuarantee, canClaimExact, type RestorePlanView } from "../contract";

export type RestorePlanViewModel = {
  readonly operation: RestoreOperation;
  readonly requiresConfirmation: boolean;
  readonly guarantee: RestorePlanView["workspaceGuarantee"];
  readonly exactAvailable: boolean;
  readonly pathCount: number;
  readonly externalChangeCount: number;
};

export function createRestorePlanViewModel(
  plan: RestorePlanView,
  capabilities: CapabilityMap,
): RestorePlanViewModel {
  assertGuarantee(plan.workspaceGuarantee, capabilities);
  return {
    operation: plan.operation,
    requiresConfirmation: plan.requiresConfirmation,
    guarantee: plan.workspaceGuarantee,
    exactAvailable: canClaimExact(capabilities),
    pathCount: plan.capturedPathCount,
    externalChangeCount: plan.externalChanges.length,
  };
}
