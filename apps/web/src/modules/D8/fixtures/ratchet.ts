import type { CommandRunResult } from "@omp-app/contracts";

/** Expected result when the A1 gateway runs the recorded omp/18.8.9 RPC frames. */
export const RECORDED_RATCHET_GATEWAY: CommandRunResult = {
  command: "/ratchet improve the answer flow",
  status: "completed",
  agentInvoked: true,
  promptSettled: true,
  sessionSettled: false,
  outputs: [],
  sessionUpdates: [],
  configUpdates: [],
};
