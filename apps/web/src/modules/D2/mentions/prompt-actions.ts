import type { TextRange } from "../contract";

/** Undo steps kept; the oldest are dropped first. */
const MAX_UNDO_STEPS = 200;

/** A `#` token still being typed (`#`, `#und`): its keystrokes are not edits to undo. */
const OPEN_TOKEN_AT_END = /(?:^|\s)#\S*$/u;

/** What one edit did, as far as undo steps are concerned: a letter or a space typed, a `#`, a deletion, or anything else. */
export type EditKind = "word" | "space" | "token" | "delete" | "other";

/**
 * omp's order for a `#` action: the token is removed first, then the action acts on the text left. As in
 * assistant-ui's action trigger, one space right after the token goes with it, so `one #copy two` leaves `one two`.
 */
export function removePromptToken(
  text: string,
  token: TextRange,
): { readonly text: string; readonly cursor: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  return {
    text: `${before}${after.startsWith(" ") ? after.slice(1) : after}`,
    cursor: before.length,
  };
}

/** The kind of a typed text: one character is a word, a space or a `#`; anything longer (a paste) is `other`. */
export function kindOfTypedText(text: string): EditKind {
  if (text.length !== 1) return "other";
  if (/\s/u.test(text)) return "space";
  return text === "#" ? "token" : "word";
}

/**
 * Whether an edit of `kind` starts a new undo step, after a step of `previous` kind. A word takes the spaces typed
 * after it; a `#` token and a run of deletions each start one of their own.
 */
function startsStep(previous: EditKind | undefined, kind: EditKind): boolean {
  if (previous === undefined || kind === "token") return true;
  if ((kind === "delete") !== (previous === "delete")) return true;
  return kind === "word" && previous !== "word";
}

/**
 * What the person typed, one undo step at a time: a word with the spaces typed after it, a `#` token, or a run of
 * deletions. Each edit is reported as the key pressed brought it, before the text changes, so steps depend only on what
 * was typed, never on timing or on how the composer batches its updates. An edit that is not one typed character (a
 * paste, a selection replaced) is not typing: it starts the history over. Text changed by a `#` action is never reported
 * here, and a `#` token being typed is not recorded, so Undo after an action reverts the last real edit.
 */
export class TypingHistory {
  readonly #steps: string[] = [];
  #kind: EditKind | undefined;

  /** An edit of `kind` is about to change `text`. */
  observeEdit(text: string, kind: EditKind): void {
    if (OPEN_TOKEN_AT_END.test(text)) return;
    if (kind === "other") {
      this.#steps.length = 0;
      this.#kind = undefined;
      return;
    }
    if (startsStep(this.#kind, kind)) {
      this.#steps.push(text);
      if (this.#steps.length > MAX_UNDO_STEPS) this.#steps.shift();
    }
    this.#kind = kind;
  }

  /**
   * The text before the last step, for Undo. `current` is the text now, with the `#` token already removed: a step
   * that leaves it unchanged is skipped. Undefined when no step is left.
   */
  undo(current: string): string | undefined {
    while (this.#steps.at(-1) === current) this.#steps.pop();
    this.#kind = undefined;
    return this.#steps.pop();
  }
}
