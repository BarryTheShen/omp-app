import type { LimitTone } from "../panels/usage/usage-words";

/**
 * The dashboard's chart colours (#15), from the theme, so each Tern theme keeps them apart: the accent first, then the
 * syntax hues.
 */
const SERIES = [
  "var(--accent)",
  "var(--syn-string)",
  "var(--syn-keyword)",
  "var(--syn-function)",
  "var(--syn-number)",
  "var(--syn-type)",
  "var(--syn-property)",
  "var(--warn)",
] as const;

/** The colour of a chart's `index`th series. */
export function seriesColor(index: number): string {
  return SERIES[index % SERIES.length] ?? "var(--accent)";
}

/** A limit's colour by how full it is, as the Usage panel's bars: the accent, warning from 75%, danger from 90%. */
export function toneColor(tone: LimitTone): string {
  if (tone === "danger") return "var(--bad)";
  if (tone === "warning") return "var(--warn)";
  return "var(--accent)";
}

/** What a running chat does, as the sidebar colours it: live while it works, warning when it waits or is paused. */
export const STATE_DOT = {
  working: "bg-live",
  waiting: "bg-warn",
  paused: "bg-warn",
  idle: "bg-t4",
} as const;
