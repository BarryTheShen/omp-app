import type { UsagePauseHold } from "@omp-app/contracts";

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** Whether the hold is the chat's own mark's (#2781 part 3) rather than a usage rule's (#2836). */
const markHold = (percent: number | null, hold: UsagePauseHold): percent is number =>
  percent !== null && hold.rule === undefined;

/**
 * What holds a chat: "at 95% of anthropic's 5-hour limit" for its own mark (#2781 part 3), or the condition of the usage
 * rule that holds it, "by a usage rule's hours" (#2836).
 */
export function holdLimitWords(percent: number | null, hold: UsagePauseHold): string {
  if (markHold(percent, hold)) return `at ${percent}% of ${hold.providerId}'s 5-hour limit`;
  switch (hold.reason ?? "five_hour") {
    case "five_hour":
      return `by a usage rule: ${hold.providerId}'s 5-hour window`;
    case "weekly":
      return `by a usage rule: ${hold.providerId}'s weekly window`;
    case "pace":
      return `by a usage rule: the pace of ${hold.providerId}'s 5-hour window`;
    case "hours":
      return "by a usage rule's hours";
  }
}

/** When a held chat goes on: at the hold's expected end, or once a reading says so (no end known). */
export function holdResumeWords(percent: number | null, hold: UsagePauseHold): string {
  if (hold.until !== null) return `resumes at ${clock.format(new Date(hold.until))}`;
  return markHold(percent, hold)
    ? `resumes once its usage is under ${percent}% again`
    : "resumes once the rule's condition ends";
}

/** The paused row's reason for a held chat: "At 95% of anthropic's 5-hour limit · resumes at 14:01". */
export function holdReason(percent: number | null, hold: UsagePauseHold): string {
  const limit = holdLimitWords(percent, hold);
  return `${limit.charAt(0).toUpperCase()}${limit.slice(1)} · ${holdResumeWords(percent, hold)}`;
}
