import type { CapabilityMap } from "@omp-app/contracts";
import {
  COLLABORATION_CAPABILITY,
  COLLABORATION_UNAVAILABLE_REASON,
  type CollaborationResult,
  type CollaborationStartResult,
} from "../contract";

/** The v18.8.9 source has terminal collaboration, but its RpcCommand union and docs/rpc.md command schema have no collaboration command/frame; I4 therefore keeps the browser AP6 gate unavailable. */
export const I4_AP6_UNAVAILABLE_FIXTURE = {
  capabilities: {
    [COLLABORATION_CAPABILITY]: {
      state: "unavailable",
      via: "upstream",
      detail: COLLABORATION_UNAVAILABLE_REASON,
    },
  } as const satisfies CapabilityMap,
  result: {
    state: "unavailable",
    error: {
      code: "unavailable",
      message: COLLABORATION_UNAVAILABLE_REASON,
      retryable: false,
      capability: COLLABORATION_CAPABILITY,
    },
  } satisfies CollaborationResult<CollaborationStartResult>,
} as const;

/** Synthetic AP6 capability fixture: the proposed typed contract is available, unlike v18.8.9. */
export const I4_AP6_AVAILABLE_FIXTURE = {
  capabilities: {
    [COLLABORATION_CAPABILITY]: { state: "available", via: "rpc" },
  } as const satisfies CapabilityMap,
  proposedContract: "collab_start/collab_join/collab_leave/collab_stop/collab_status",
} as const;

export const I4_FIXTURES = {
  unavailable: I4_AP6_UNAVAILABLE_FIXTURE,
  available: I4_AP6_AVAILABLE_FIXTURE,
} as const;
