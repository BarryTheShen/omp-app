import type { UsageLimitStage } from "../contract";

/** What the dialog says when omp reports that the model has no slow mode. */
export const SLOW_UNSUPPORTED_TEXT = "Slow mode is not available for this model.";

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });

/**
 * When a limit resets, in the person's own timezone: "resets at 4:30 PM" on the same day, "resets on Tuesday at
 * 4:30 PM" otherwise. Undefined when the epoch seconds do not make a date.
 */
function resetPhrase(resetsAtSec: number, now: Date): string | undefined {
  const at = new Date(resetsAtSec * 1000);
  if (Number.isNaN(at.getTime())) return undefined;
  if (at.toDateString() === now.toDateString()) return `resets at ${CLOCK.format(at)}`;
  return `resets on ${WEEKDAY.format(at)} at ${CLOCK.format(at)}`;
}

/** The plain sentence for omp's usage-limit stage, with the reset time when omp gave one. */
export function usageLimitText(stage: UsageLimitStage, now: Date = new Date()): string {
  if (stage.stage === "low_priority") {
    const reset = resetPhrase(stage.resetsAtSec, now) ?? "resets";
    const left =
      stage.allowanceLeftPercent === undefined
        ? ""
        : ` ${Math.round(stage.allowanceLeftPercent)}% of the low-priority allowance is left.`;
    return `Requests run at low priority until your limit ${reset}.${left}`;
  }
  const reset = stage.resetsAtSec === undefined ? undefined : resetPhrase(stage.resetsAtSec, now);
  if (stage.extraUsage) {
    return `Your usage limit is reached. Requests get a short wrap-up allowance, then paid extra usage serves them${reset ? `. Your limit ${reset}` : ""}.`;
  }
  return `Your usage limit is reached. Requests get a short wrap-up allowance, then wait until your limit ${reset ?? "resets"}.`;
}
