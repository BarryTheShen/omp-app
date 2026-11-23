/**
 * omp's name for the Nth picture of a message, in its text: `[Image #N, WxH]` or `[Image #N]` (omp's terminal writes it
 * when a picture is pasted; `@oh-my-pi/pi-tui` prompt/composer-attachments.ts). The number is in group 1.
 */
export const IMAGE_MARKER_PATTERN = /\[Image #([1-9]\d*)(?:,[^\]\n]*)?\]/;

/** The text without its pictures' names, as a chat's title reads it ("[Image #1, 1x1] fix this" → "fix this"). */
export function withoutImageMarkers(text: string): string {
  return text
    .replace(new RegExp(` ?${IMAGE_MARKER_PATTERN.source} ?`, "g"), " ")
    .replace(/ {2,}/g, " ")
    .trim();
}
