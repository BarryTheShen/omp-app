import type { UsagePauseHold } from "@omp-app/contracts";

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** The limit a held chat reached: "at 95% of anthropic's 5-hour limit" (#2781 part 3). */
export function holdLimitWords(percent: number, hold: UsagePauseHold): string {
  return `at ${percent}% of ${hold.providerId}'s 5-hour limit`;
}

/** When a held chat goes on: at the window's reset, or once a read finds it under its limit (no reset time known). */
export function holdResumeWords(percent: number, hold: UsagePauseHold): string {
  return hold.until === null
    ? `resumes once its usage is under ${percent}% again`
    : `resumes at ${clock.format(new Date(hold.until))}`;
}

/** The paused row's reason for a held chat: "At 95% of anthropic's 5-hour limit · resumes at 14:01". */
export function holdReason(percent: number, hold: UsagePauseHold): string {
  return `At ${percent}% of ${hold.providerId}'s 5-hour limit · ${holdResumeWords(percent, hold)}`;
}
