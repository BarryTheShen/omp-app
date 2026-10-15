import { type AppFailure, type CapabilityMap, CapabilityStatus } from "@omp-app/contracts";
import {
  AP6_UNAVAILABLE_REASONS,
  D8_AP6_CAPABILITIES,
  type D8Ap6Capability,
  unavailableAutonomy,
} from "../contract";

/** One AP6 seam D8 declares, as omp publishes it today: unavailable, with the reason the app shows. */
export interface Ap6UnavailableFixture {
  readonly feature: keyof typeof D8_AP6_CAPABILITIES;
  readonly capability: D8Ap6Capability;
  readonly status: CapabilityStatus;
  readonly failure: AppFailure;
}

/** Every AP6 seam as the unavailable capability state and the typed failure a surface receives. */
export const AP6_UNAVAILABLE_FIXTURES: readonly Ap6UnavailableFixture[] = (
  Object.keys(D8_AP6_CAPABILITIES) as (keyof typeof D8_AP6_CAPABILITIES)[]
).map((feature) => {
  const capability = D8_AP6_CAPABILITIES[feature];
  const reason = AP6_UNAVAILABLE_REASONS[feature];
  return {
    feature,
    capability,
    status: CapabilityStatus.parse({ state: "unavailable", via: "upstream", detail: reason }),
    failure: unavailableAutonomy(capability, reason),
  };
});

/**
 * The released goal command on a connection where omp publishes it. Assumed for the test: no recording on main shows this
 * state. The probe that publishes `omp.cmd.goal` labels its source at `packages/server/src/capabilities/index.ts:116`.
 */
export const GOAL_RPC_AVAILABLE: CapabilityMap = {
  "omp.cmd.goal": CapabilityStatus.parse({ state: "available", via: "rpc" }),
};

/** The released goal command where omp does not publish it. Assumed for the test, like GOAL_RPC_AVAILABLE. */
export const GOAL_RPC_UNAVAILABLE: CapabilityMap = {
  "omp.cmd.goal": CapabilityStatus.parse({ state: "unavailable", via: "rpc" }),
};
