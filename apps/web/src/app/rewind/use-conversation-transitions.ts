import type { CapabilityMap, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { useMemo } from "react";
import {
  type ConversationTransitionPort,
  createOmpConversationTransitionPort,
} from "@/modules/P4/transitions";
import { createOmpBranchingController } from "@/modules/R0/branching";
import type { PromptIntent } from "@/modules/R0/runtime/runtime";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { type NoSwitchNote, withNoSwitchNote } from "./no-switch-notice";
import { isStreaming } from "./rewind-tree";

export interface ConversationTransitionOptions {
  readonly store: OmpRuntimeStore;
  readonly send: RpcSessionSend;
  readonly capabilities: CapabilityMap;
  readonly submitPrompt: (intent: PromptIntent) => Promise<void>;
  /** R1's thread switch: it loads the chosen session's history before it resolves. */
  readonly switchThread: (threadId: ThreadId) => Promise<void>;
  /** The chat picks made so far; a rewind or fork that finishes after a pick does not switch the view. */
  readonly pickCount: () => number;
  /** Writes a rewind's or fork's note into the chat on screen, when it finished without switching the view. */
  readonly deliverNote: (note: NoSwitchNote) => void;
}

/**
 * The port that rewinds, forks and branches the chat on screen. The rewind panel and the `/fork` command share one
 * instance, so both refuse while a turn runs and both write their note the same way.
 */
export function useConversationTransitions({
  store,
  send,
  capabilities,
  submitPrompt,
  switchThread,
  pickCount,
  deliverNote,
}: ConversationTransitionOptions): ConversationTransitionPort {
  return useMemo<ConversationTransitionPort>(() => {
    const branchingController = createOmpBranchingController({
      store,
      send,
      submitPrompt,
      // `switchThread` already reloads the chosen session's history, so there is nothing to reload.
      reloadHistory: async () => undefined,
      switchThread,
    });
    const port = createOmpConversationTransitionPort({
      store,
      send,
      branchingController,
      capabilities,
      pickCount,
      isBusy: () => isStreaming(store),
    });
    // The chat on screen is the one the person picked last, so the note is written through its view.
    return withNoSwitchNote(port, deliverNote);
  }, [capabilities, deliverNote, pickCount, send, store, submitPrompt, switchThread]);
}
