import { useRef, useState } from "react";
import type { AgentRef, FocusedAgentRuntime } from "@/modules/P1/contract";
import {
  CANCEL_REFUSED_MESSAGE,
  type CancelControl,
  type CancelPhase,
  cancelFailureMessage,
} from "@/modules/P1/panels/model";
import { asAppFailure } from "./failures";

/**
 * The cancel control for one nested worker, worded as the Agent Hub words it: a running worker can be
 * cancelled, omp's refusal keeps it running with the words that say so, and a worker that has ended
 * shows no control (or omp's plain reason, when its answer was that it had ended).
 */
export function nestedCancelControl(
  agent: AgentRef,
  phase: CancelPhase | undefined,
): CancelControl {
  if (agent.status !== "running") {
    return phase?.state === "failed" && phase.error.code === "not_found"
      ? { state: "ended", message: cancelFailureMessage(phase.error) }
      : { state: "hidden" };
  }
  if (phase === undefined) return { state: "ready" };
  if (phase.state === "failed") {
    return {
      state: "failed",
      message: cancelFailureMessage(phase.error),
      retryable: phase.error.retryable,
    };
  }
  if (phase.state === "refused") return { state: "refused", message: CANCEL_REFUSED_MESSAGE };
  return { state: phase.state };
}

/** omp answers a conflict when it refuses to stop a worker it still runs; any other failure is shown as one. */
function phaseOf(error: unknown): CancelPhase {
  const appError = asAppFailure(error).appError;
  return appError.code === "conflict" ? { state: "refused" } : { state: "failed", error: appError };
}

/**
 * The cancel control of one nested worker, its label and its action. A press while a cancel is sent is
 * ignored, as the Agent Hub ignores it.
 */
export function useNestedCancel(runtime: Pick<FocusedAgentRuntime, "agent" | "cancel">) {
  const [phase, setPhase] = useState<CancelPhase | undefined>(undefined);
  const inFlight = useRef(false);
  const cancel = (): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase({ state: "sending" });
    void runtime
      .cancel()
      .then(
        () => setPhase({ state: "sent" }),
        (error: unknown) => setPhase(phaseOf(error)),
      )
      .finally(() => {
        inFlight.current = false;
      });
  };
  return {
    control: nestedCancelControl(runtime.agent, phase),
    cancel,
    title: runtime.agent.description?.trim() || runtime.agent.id,
  };
}
