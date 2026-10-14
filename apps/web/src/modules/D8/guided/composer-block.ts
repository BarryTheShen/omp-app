/**
 * The one block the interview keeps in the message box: the text it last put there, where that text starts, and the
 * whole box as the interview last left it. Only this block is replaced or removed; the rest of the box is the person's.
 */
export interface KeptBlock {
  readonly text: string;
  readonly start: number;
  readonly written: string;
}

export interface PlacedBlock {
  /** The box's value once the block is placed. */
  readonly value: string;
  readonly kept: KeptBlock;
  /** `false` when the box already ends with the text, so nothing needs writing. */
  readonly write: boolean;
}

const SEPARATOR = "\n\n";

function withoutTrailingSpace(text: string): string {
  return text.replace(/\s+$/u, "");
}

/**
 * Places `text` (not blank) in the box as the interview's block. A box that already ends with `text` is left as it is.
 * Otherwise the block kept last is replaced where it still is, so repeated writes never stack. When it is gone, `text`
 * is added after what the person has typed, with a blank line between.
 */
export function placeBlock(current: string, text: string, kept: KeptBlock | null): PlacedBlock {
  const body = withoutTrailingSpace(current);
  if (body.endsWith(text)) {
    const start = body.length - text.length;
    return { value: current, kept: { text, start, written: current }, write: false };
  }
  if (kept !== null && kept.text !== "") {
    const at = current.lastIndexOf(kept.text);
    if (at !== -1) {
      const value = current.slice(0, at) + text + current.slice(at + kept.text.length);
      return { value, kept: { text, start: at, written: value }, write: true };
    }
  }
  const prefix = body === "" ? "" : `${body}${SEPARATOR}`;
  const value = prefix + text;
  return { value, kept: { text, start: prefix.length, written: value }, write: true };
}

/**
 * The box without the kept block, or `null` when the box no longer holds exactly what the interview wrote: the person
 * has changed it since, so it is left alone. The blank line the block came with goes too.
 */
export function removeBlock(current: string, kept: KeptBlock): string | null {
  if (current !== kept.written) return null;
  const before = kept.written.slice(0, kept.start);
  const after = kept.written.slice(kept.start + kept.text.length);
  return withoutTrailingSpace(before + after);
}
