import type { ModeChangeResult } from "@omp-app/contracts";
import { MODE_LABELS } from "./commands";
import { SLOW_UNSUPPORTED_TEXT } from "./slow";

/** The outcomes omp answered with a typed reply. An unknown reply is not among them: it is shown as omp wrote it. */
export type TypedModeOutcome = Exclude<ModeChangeResult, { readonly outcome: "unknown" }>;

/**
 * The plain sentence for one typed outcome: a change omp made, or why omp did not make it. Written for a person;
 * omp's own words never reach this text.
 */
export function modeOutcomeText(outcome: TypedModeOutcome): string {
  if (outcome.outcome === "applied") {
    if (outcome.mode === "browser") {
      return `Browser use is set to ${outcome.visibility === "visible" ? "Visible window" : "Headless"}.`;
    }
    return `${MODE_LABELS[outcome.mode]} is ${outcome.on ? "on" : "off"}.`;
  }
  switch (outcome.reason) {
    case "model-has-no-slow-mode":
      return SLOW_UNSUPPORTED_TEXT;
    case "not-in-session":
      return "Computer use is not available in this chat.";
    case "not-offered":
      return "omp does not offer this setting here.";
    case "claude-usage-limit":
      return "Slow mode stayed off: the Claude usage limit has been reached.";
    case "browser-restart-failed":
      return "The browser could not restart in that window. Try again.";
  }
}

/** Whether the same change can be tried again as it is: only a browser window that failed to restart. */
export function modeOutcomeRetryable(outcome: TypedModeOutcome): boolean {
  return outcome.outcome === "refused" && outcome.reason === "browser-restart-failed";
}
