import type { RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { useMemo } from "react";
import { createOmpBranchingController } from "@/modules/R0/branching";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import type { EditRunDecorator } from "../contract";
import { createP3RunHandlers, type P3RunHandlers } from "./handlers";
import { createP3EditRun } from "./run";
import type { P3Runs } from "./runs";

export interface P3RunHooksOptions {
  /** The open chat's store: its branch controller reads the source entries from here. */
  readonly store: OmpRuntimeStore;
  readonly send: RpcSessionSend;
  /** Opens a chat, as the composition's history does; a branch uses it to switch to the new chat. */
  readonly openThread: (threadId: ThreadId) => Promise<void>;
  readonly runs: P3Runs;
  /** P5's optional decorator, supplied at composition time. P5 is not mounted yet. */
  readonly decorator?: EditRunDecorator | undefined;
}

/** The edit and regenerate handlers for one open chat, bound to that chat's store and send. */
export function useP3RunHandlers(options: P3RunHooksOptions): P3RunHandlers {
  const { store, send, openThread, runs, decorator } = options;
  return useMemo(() => {
    const branching = createOmpBranchingController({
      store,
      send,
      submitPrompt: async (intent) => {
        await runs.handoff.submit(intent);
      },
      // openThread resolves only after the new chat's history has loaded, so there is nothing to reload.
      reloadHistory: async () => undefined,
      switchThread: (threadId) => {
        runs.handoff.expect(threadId);
        return openThread(threadId);
      },
    });
    const run = createP3EditRun({ branching, handoff: runs.handoff, decorator });
    return createP3RunHandlers({ store, run, handoff: runs.handoff, status: runs.status });
  }, [decorator, openThread, runs, send, store]);
}
