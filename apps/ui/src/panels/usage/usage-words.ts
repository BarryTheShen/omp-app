/** How far a limit's bar is drawn: the used share, held within the track. An unknown share draws nothing. */
export function barPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0;
  return Math.min(100, Math.max(0, usedPercent));
}

/** The colour step of a limit's bar: warning from 75% used, danger from 90%. */
export type LimitTone = "normal" | "warning" | "danger";

export function limitTone(usedPercent: number): LimitTone {
  if (!Number.isFinite(usedPercent)) return "normal";
  if (usedPercent >= 90) return "danger";
  if (usedPercent >= 75) return "warning";
  return "normal";
}

/** The time left until a limit resets, in plain words: "resets in 2 h 5 min", "resets in 1 d 1 h". */
export function resetsInWords(resetsAt: string | null, now: Date): string {
  if (resetsAt === null) return "reset time unknown";
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return "reset time unknown";
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "resets now";
  if (minutes < 60) return `resets in ${minutes} min`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return `resets in ${Math.floor(minutes / 60)} h${rest > 0 ? ` ${rest} min` : ""}`;
  }
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  return `resets in ${Math.floor(minutes / (24 * 60))} d${hours > 0 ? ` ${hours} h` : ""}`;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });

/** When a window resets, as a clock time: "at 4:30 PM" on the same day, "on Tuesday at 4:30 PM" otherwise. */
export function resetAtWords(resetsAt: string | null, now: Date): string {
  if (resetsAt === null) return "omp did not say when it resets";
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return "omp did not say when it resets";
  if (at.toDateString() === now.toDateString()) return `resets at ${clock.format(at)}`;
  return `resets on ${weekday.format(at)} at ${clock.format(at)}`;
}

/**
 * A window two or more accounts report, as omp's combined line counts it (`computeProviderWindowStats`, #13): their
 * shares added up out of how many accounts, what is left in accounts' worth, and the bar's share of them all. Null for
 * one account, and from a server that sends only the fullest account's share.
 */
export function combinedShare(window: {
  readonly accounts: number;
  readonly usedAccounts?: number;
}): { readonly percent: number; readonly used: string; readonly left: string } | null {
  if (window.accounts < 2 || window.usedAccounts === undefined) return null;
  return {
    percent: (window.usedAccounts / window.accounts) * 100,
    used: `${window.usedAccounts.toFixed(2)} of ${window.accounts} used`,
    left: `${Math.max(0, window.accounts - window.usedAccounts).toFixed(2)}× quota left`,
  };
}
