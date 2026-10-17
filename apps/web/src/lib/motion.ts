/**
 * Motion shared by the rows that appear live (issue 1173): a new message, a new session row, a notice. Each one fades; none
 * moves, grows or shrinks, so the transcript's scroll anchoring never sees a layout change from them. The timing comes
 * from the tokens (`--duration-base`, `--ease-standard`), and `motion-reduce` switches every one of these off.
 */

/** A row whose time is this recent (in ms) is new. History that loads, and a reload, are older than this. */
export const NEW_ROW_WINDOW_MS = 3000;

/**
 * A row that appears live fades in once: it starts transparent (`@starting-style`, which applies only when the element is
 * inserted), then transitions to opaque. Rows that are already drawn when the list loads have no such start, so they stay.
 */
export const ENTER_FADE =
  "starting:opacity-0 transition-opacity duration-(--duration-base) ease-(--ease-standard) motion-reduce:transition-none";

/** A row that is leaving fades out over the same token. It is removed after `LEAVE_MS`, when the fade has run. */
export const LEAVE_FADE =
  "opacity-0 transition-opacity duration-(--duration-base) ease-(--ease-standard) motion-reduce:transition-none";

/** How long a leaving row stays drawn: the base token plus a margin, so its fade always ends first. */
export const LEAVE_MS = 200;

/**
 * A notice has no time of its own, so a notice counts as live only after its stack has been drawn this long. A notice
 * that a reload draws again is not judged by this window: the drawn-notice memory keeps it from fading in.
 */
export const NOTICE_SETTLE_MS = 2000;

/** Whether a time (epoch ms) is recent enough to fade in. A time in the future is not recent. */
export function isRecent(epochMs: number | undefined, now: number = Date.now()): boolean {
  if (epochMs === undefined || !Number.isFinite(epochMs)) return false;
  const age = now - epochMs;
  return age >= 0 && age < NEW_ROW_WINDOW_MS;
}
