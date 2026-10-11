import type { CommandDescriptor } from "@omp-app/contracts";

/**
 * The palette command that opens the execution-mode controls of the open chat. The palette lists it
 * only while a chat is open: the chat registers its handler (`app/execution-modes.tsx`).
 */
export const D7_EXECUTION_MODES_COMMAND = {
  kind: "command",
  id: "D7.executionModes",
  owner: "D7",
  title: "Execution modes",
  covers: [],
  requires: [],
} as const satisfies CommandDescriptor;
