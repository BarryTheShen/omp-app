import type { CapabilityKey, CapabilityMap } from "@omp-app/contracts";
import { D8_AP6_CAPABILITIES } from "../contract";

export const LOOP_CAPABILITY: CapabilityKey = D8_AP6_CAPABILITIES.loop;

export const LOOP_UNAVAILABLE_REASON =
  "Loops are not available in this app yet. omp runs loops from its terminal, and this app will not repeat your prompt on a timer or check a condition itself.";

export type LoopGate =
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: string };

/** Loop controls exist only when omp publishes `upstream.loop`; otherwise the surface explains why it is absent. */
export function loopGate(capabilities: CapabilityMap | undefined): LoopGate {
  if (capabilities?.[LOOP_CAPABILITY]?.state === "available") return { state: "available" };
  return { state: "unavailable", reason: LOOP_UNAVAILABLE_REASON };
}
