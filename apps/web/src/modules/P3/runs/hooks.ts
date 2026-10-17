import type { RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { useEffect, useMemo } from "react";
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
  /**
   * Switches to the chat a branch made. The chat is opened again even when its id already names it: omp moves the
   * running session to the branch in place, so the store on screen can still be the source's (see root's `switchChat`).
   */
  readonly switchChat: (threadId: ThreadId) => Promise<void>;
  readonly runs: P3Runs;
  /** P5's optional decorator, supplied at composition time. P5 is not mounted yet. */
  readonly decorator?: EditRunDecorator | undefined;
}

/** The edit and regenerate handlers for one open chat, bound to that chat's store and send. */
export function useP3RunHandlers(options: P3RunHooksOptions): P3RunHandlers {
  const { store, send, switchChat, runs, decorator } = options;
  const handlers = useMemo(() => {
    const branching = createOmpBranchingController({
      store,
      send,
      submitPrompt: async (intent) => {
        await runs.handoff.submit(intent);
      },
      // switchChat resolves only after the new chat's history has loaded, so there is nothing to reload.
      reloadHistory: async () => undefined,
      onBranched: () => runs.handoff.markBranched(),
      switchThread: (threadId) => {
        runs.handoff.expect(threadId);
        return switchChat(threadId);
      },
    });
    const run = createP3EditRun({ branching, handoff: runs.handoff, decorator });
    return createP3RunHandlers({ store, run, handoff: runs.handoff, status: runs.status });
  }, [decorator, runs, send, store, switchChat]);

  useEffect(() => {
    const syncSettled = (): void => {
      const state = runs.status.getSnapshot();
      const snapshot = store.getSnapshot();
      if (state.phase !== "sent" || state.threadId !== snapshot.threadId) return;
      const prompt = snapshot.prompt;
      const settled =
        (prompt.sessionSettled && prompt.promptResult !== null) ||
        (snapshot.process.status === "exited" && prompt.admitted);
      if (!state.settled && settled) runs.status.set({ ...state, settled });
    };
    syncSettled();
    const unsubscribeStore = store.subscribe(syncSettled);
    const unsubscribeStatus = runs.status.subscribe(syncSettled);
    return () => {
      unsubscribeStore();
      unsubscribeStatus();
    };
  }, [runs.status, store]);
  return handlers;
}
