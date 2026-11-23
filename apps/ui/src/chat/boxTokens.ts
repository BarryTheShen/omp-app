/**
 * References in the message box are pointers: one piece each, whole or not at all. A picture's `[Image #N, WxH]`, a
 * secret's placeholder (`$$NAME_CODE:L$$`), and the mentions the box put in itself (an extension's `@Birthday menu`,
 * a file's `@src/app.ts` from the `@` menu). An edit that touches part of one takes it whole, typing never lands inside
 * one, and the caret steps over it. The box stays a text field (a phone's keyboard, input methods and paste all work);
 * these functions keep its text whole around each edit and each move of the caret.
 */
import { IMAGE_MARKER_PATTERN, SECRET_PLACEHOLDER_PATTERN } from "@omp-app/contracts";

/** A reference's place in the text: `start` to `end`, the end not included. */
export interface BoxToken {
  readonly start: number;
  readonly end: number;
}

/** The text and caret an edit leaves once every reference it touched is whole again. */
export interface KeptEdit {
  readonly text: string;
  readonly caret: number;
}

const PATTERNS = [IMAGE_MARKER_PATTERN, SECRET_PLACEHOLDER_PATTERN].map(
  (pattern) => new RegExp(pattern.source, "g"),
);

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every reference in the text, in order, none overlapping: the markers and placeholders by their pattern, and each
 * `known` mention (the labels and file mentions the box put in) where it stands as a whole word: after the start, a
 * space or a line, and not followed by more of a word (as `expandMentions` reads them back).
 */
export function tokensIn(text: string, known: Iterable<string>): BoxToken[] {
  const found: BoxToken[] = [];
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern))
      found.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const mention of known) {
    if (mention === "") continue;
    const whole = new RegExp(`(^|\\s)(${escaped(mention)})(?![\\p{L}\\p{N}_-])`, "gu");
    for (const match of text.matchAll(whole)) {
      const start = match.index + (match[1]?.length ?? 0);
      found.push({ start, end: start + mention.length });
    }
  }
  // Longer first where two start together, then the first of any two that overlap.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: BoxToken[] = [];
  for (const token of found) {
    const last = kept.at(-1);
    if (last === undefined || token.start >= last.end) kept.push(token);
  }
  return kept;
}

/**
 * The edit that turned `before` into `after` (the caret now at `caret`), with every reference it touched in part taken
 * whole: a Backspace or Delete at its edge, a word deleted across it, a selection typed over half of it, an
 * autocorrection. Text typed inside one goes after it instead. `null` when the edit left every reference whole or
 * untouched. The edit's span is what the two texts do not share, read from the caret: what follows the caret is kept,
 * and what precedes it as far as the texts agree.
 */
export function keepWhole(
  before: string,
  after: string,
  caret: number,
  tokens: readonly BoxToken[],
): KeptEdit | null {
  if (before === after || tokens.length === 0) return null;
  const longest = Math.min(before.length, after.length);
  let suffix = 0;
  const suffixRoom = Math.min(after.length - caret, longest);
  while (
    suffix < suffixRoom &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  let prefix = 0;
  const prefixRoom = longest - suffix;
  while (prefix < prefixRoom && before[prefix] === after[prefix]) prefix++;
  const removedEnd = before.length - suffix;
  const inserted = after.slice(prefix, after.length - suffix);

  if (removedEnd === prefix) {
    // Only text put in: inside a reference it goes after it.
    const inside = tokens.find((token) => token.start < prefix && prefix < token.end);
    if (inside === undefined) return null;
    return {
      text: before.slice(0, inside.end) + inserted + before.slice(inside.end),
      caret: inside.end + inserted.length,
    };
  }
  let start = prefix;
  let end = removedEnd;
  for (const token of tokens) {
    if (token.start < removedEnd && token.end > prefix) {
      start = Math.min(start, token.start);
      end = Math.max(end, token.end);
    }
  }
  if (start === prefix && end === removedEnd) return null;
  return {
    text: before.slice(0, start) + inserted + before.slice(end),
    caret: start + inserted.length,
  };
}

/**
 * A selection kept off references' insides. A caret inside one goes to its edge: the far edge in the direction it moved
 * from `previous` (an arrow steps over it), the nearer edge otherwise (a tap). A selection that cuts one takes it whole.
 */
export function snapSelection(
  start: number,
  end: number,
  tokens: readonly BoxToken[],
  previous: number | null,
): BoxToken {
  const inside = (at: number) => tokens.find((token) => token.start < at && at < token.end);
  if (start === end) {
    const token = inside(start);
    if (token === undefined) return { start, end };
    const edge =
      previous !== null && previous <= token.start
        ? token.end
        : previous !== null && previous >= token.end
          ? token.start
          : start - token.start <= token.end - start
            ? token.start
            : token.end;
    return { start: edge, end: edge };
  }
  return { start: inside(start)?.start ?? start, end: inside(end)?.end ?? end };
}
