/** Text and value helpers for the status segments: plain text in, plain text out. */

/**
 * One line of plain text from text omp or GitHub supplied. C0 and C1 controls and the bidi overrides and
 * isolates (which can hide or reorder text) become spaces, and runs of spaces collapse. The result is
 * shown as text, never as markup.
 */
export function safeText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const unsafe =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    out += unsafe ? " " : char;
  }
  return out.replace(/\s+/gu, " ").trim();
}

/** The link for a pull request, or `undefined` when the address is not an https link. */
export function pullRequestHref(url: string): string | undefined {
  // An address that does not parse is not a link: the chip then shows its number without one.
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** A stable accent for a session name: the same name always gets the same index, from 1 to `count`. */
export function accentIndex(text: string, count: number): number {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % count) + 1;
}

/** The local clock as omp shows it by default: 24 hours, with no leading zero on the hour. */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * A duration as omp writes its active-time figure (omp 18.12.6 `packages/utils/src/format.ts`, rounding at lines 13-17):
 * "42.3s", "3m5s", "2h30m", "3d2h".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < SEC) return `${Math.floor(ms)}ms`;
  if (ms < MIN) {
    // Round to tenths first: `toFixed(1)` alone turns 59.95 s into an impossible "60.0s".
    const tenths = Math.round(ms / 100);
    return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : "1m";
  }
  if (ms < HOUR) {
    const mins = Math.floor(ms / MIN);
    const secs = Math.floor((ms % MIN) / SEC);
    return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const mins = Math.floor((ms % HOUR) / MIN);
    return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

/**
 * The name a person reads for a folder: its last part, so `~/code/projects/omp-app` shows `omp-app`. A path with
 * no name (the root) is shown whole. The full path is in the folder's tooltip.
 */
export function folderName(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.at(-1) ?? path;
}
