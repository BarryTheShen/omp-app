/**
 * The pictures of a message named in its text, as omp's own terminal names them: `[Image #N, WxH]` (or `[Image #N]`)
 * for the Nth picture that goes with the message, in its order. The marker is plain text, so the model reads which
 * picture the person means where they mean it, and omp's terminal shows the same marker for the same picture. The
 * rules are omp's (`@oh-my-pi/pi-tui` prompt/composer-attachments.ts): numbers are positional, a picture whose marker was
 * deleted is not sent, and the ones left are numbered 1..K again.
 */
import { IMAGE_MARKER_PATTERN } from "@omp-app/contracts";

/** Every marker in a text (contracts' `IMAGE_MARKER_PATTERN`): its number in group 1. */
const MARKER = new RegExp(IMAGE_MARKER_PATTERN.source, "g");
/** The same, with the one space before it when there is one. */
const SPACED_MARKER = new RegExp(` ?${IMAGE_MARKER_PATTERN.source}`, "g");

/** The marker for the `n`th picture: with its size when known, as omp writes it. */
export function imageMarker(
  n: number,
  size?: { readonly width: number; readonly height: number },
): string {
  return size === undefined ? `[Image #${n}]` : `[Image #${n}, ${size.width}x${size.height}]`;
}

/** The picture numbers the text's markers name, in order of first appearance. */
export function markedImages(text: string): number[] {
  const seen: number[] = [];
  for (const match of text.matchAll(MARKER)) {
    const n = Number(match[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}

/**
 * The text with each marker's number changed by `to`: a number, or null to take the marker out (with the one space
 * before it, so "see [Image #2] here" becomes "see here"). A marker `to` leaves as it was stays as it was written.
 */
export function renumberImageMarkers(text: string, to: (n: number) => number | null): string {
  return text.replace(SPACED_MARKER, (whole, number: string) => {
    const n = Number(number);
    const next = to(n);
    if (next === null) return "";
    if (next === n) return whole;
    // What follows the number (its size) stays as it was written.
    const head = `[Image #${number}`;
    return whole.replace(head, `[Image #${next}`);
  });
}

/**
 * What a message sends, as omp's terminal sends it: when its text names any of its `count` pictures, only the named
 * ones go, numbered 1..K in their order, and the text's markers follow; a text that names none sends every picture as
 * it is (a picture added without a marker, or a message from before markers). `keep` holds the pictures' places.
 */
export function compactImageMarkers(
  text: string,
  count: number,
): { readonly text: string; readonly keep: readonly number[] } {
  const named = markedImages(text).filter((n) => n <= count);
  const all = Array.from({ length: count }, (_, index) => index);
  if (named.length === 0) return { text, keep: all };
  const keep = [...named].sort((a, b) => a - b).map((n) => n - 1);
  const next = new Map(keep.map((place, index) => [place + 1, index + 1]));
  return {
    text: renumberImageMarkers(text, (n) => (n > count ? n : (next.get(n) ?? n))),
    keep,
  };
}
