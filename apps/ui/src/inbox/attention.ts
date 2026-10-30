import type { ChatSessionEvent } from "@omp-app/contracts";

/**
 * What a chat did that may need you, as omp's run status says it (its OSC 7501 record, omp 18.12.6
 * `utils/run-status.ts`): a turn done with a result to read, a turn that stopped with an error (omp's reason), or the
 * chat's omp gone: it quit on its own, or could not start.
 */
export type Attention =
  | { readonly kind: "done" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "crashed"; readonly reason: string }
  | { readonly kind: "unstarted"; readonly reason: string };

/** A message as `agent_end` carries it: omp reads the end of the turn's last reply. */
interface TurnMessage {
  readonly role: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

/**
 * omp's rule for a run that settled (18.12.6 `modes/controllers/event-controller.ts`, `#settledRunStatus`): done when
 * the turn's last reply ended normally, an error when it stopped with one, and nothing when it was aborted or there is
 * no reply.
 */
function outcomeOf(messages: readonly TurnMessage[]): Attention | null {
  const last = messages.findLast((message) => message.role === "assistant");
  if (last?.stopReason === "error") return { kind: "error", reason: last.errorMessage ?? "" };
  if (last === undefined || last.stopReason === "aborted") return null;
  return { kind: "done" };
}

/**
 * Follows one chat's live events and says when its run settles with something to look at. A final `agent_end` is
 * judged at once; while omp retries, an end says nothing (omp's `#retryPending`). An end with more to come
 * (`isTerminal: false`: a queued message, a background job's result) is said when the session settles, unless a new
 * run starts first. A chat's omp that exits on its own, or fails to start, is said at once; one the server stops is not.
 */
export class AttentionTracker {
  #retrying = false;
  /** The outcome of an end with more to come, until the session settles or another run starts. */
  #pending: Attention | null = null;

  /** One live event of the chat; what it settled with, or null. */
  take(payload: ChatSessionEvent): Attention | null {
    if (payload.kind === "process") {
      if (payload.status !== "exited" && payload.status !== "error") return null;
      this.#pending = null;
      this.#retrying = false;
      const reason = payload.error?.message ?? "";
      return payload.status === "exited"
        ? { kind: "crashed", reason }
        : { kind: "unstarted", reason };
    }
    if (payload.kind !== "event") return null;
    const { event } = payload;
    switch (event.type) {
      case "agent_start":
        this.#pending = null;
        return null;
      case "auto_retry_start":
        this.#retrying = true;
        return null;
      case "auto_retry_end":
        this.#retrying = false;
        return null;
      case "agent_end": {
        const outcome = this.#retrying ? null : outcomeOf(event.messages);
        if (event.isTerminal === false) {
          this.#pending = outcome;
          return null;
        }
        this.#pending = null;
        return outcome;
      }
      case "session_settled": {
        const outcome = this.#pending;
        this.#pending = null;
        return outcome;
      }
      default:
        return null;
    }
  }
}
