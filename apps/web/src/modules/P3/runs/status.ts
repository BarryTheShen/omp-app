import type { EntryId, ThreadId } from "@omp-app/contracts";
import type { WorkspaceGuarantee } from "../contract";

/** Editing a sent message, or asking again for an answer. */
export type P3RunKind = "edit" | "regenerate";

/** The text and images a run sends: the person's replacement, or the original message for an answer asked again. */
export interface P3RunReplacement {
  readonly text: string;
  readonly images: readonly unknown[];
}

/** What every phase of a run knows about where it started. */
export interface P3RunRecord {
  readonly kind: P3RunKind;
  /** The user message the run starts from; null when the action names no stored message. */
  readonly sourceEntryId: EntryId | null;
  /** The chat the run started in, which the person can return to. */
  readonly sourceThreadId: ThreadId;
  readonly replacement: P3RunReplacement;
}

export type P3SentState = P3RunRecord & {
  readonly phase: "sent";
  /** The new chat omp opened for the run. */
  readonly threadId: ThreadId;
  /** Whether omp has sent session_settled after the prompt result. */
  readonly settled: boolean;
  readonly workspaceGuarantee: WorkspaceGuarantee;
  readonly externalChanges: readonly string[];
  readonly partialFailure: string | null;
};

export type P3FailedState = P3RunRecord & {
  readonly phase: "failed";
  /** True once omp opened a new chat for the run: a retry then sends on that chat, without branching again. */
  readonly branched: boolean;
  /** The chat a retry runs in: the new chat after a branch, otherwise the source chat. */
  readonly chatThreadId: ThreadId;
  readonly message: string;
  readonly retryable: boolean;
};

export type P3RunState =
  | { readonly phase: "idle" }
  | (P3RunRecord & { readonly phase: "sending" })
  | P3SentState
  | P3FailedState;

/** The one run status a composition shares. A run switches chats, so the status cannot live in one chat. */
export interface P3RunStatus {
  getSnapshot(): P3RunState;
  subscribe(listener: () => void): () => void;
  set(state: P3RunState): void;
  /**
   * Ends a finished or failed run's notice: the person closed it, opened another chat, or sent another
   * message. A run still sending is left alone, because its outcome is not known yet.
   */
  dismiss(): void;
}

export function createP3RunStatus(): P3RunStatus {
  let state: P3RunState = { phase: "idle" };
  const listeners = new Set<() => void>();
  const publish = (next: P3RunState): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: publish,
    dismiss() {
      if (state.phase !== "sent" && state.phase !== "failed") return;
      publish({ phase: "idle" });
    },
  };
}
