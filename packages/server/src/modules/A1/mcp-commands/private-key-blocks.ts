// A private-key block is a BEGIN header through the first END header after it (#869).
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

/** The first match of a global pattern at or after `from`, or undefined when there is none. */
function matchFrom(pattern: RegExp, text: string, from: number): RegExpExecArray | undefined {
  pattern.lastIndex = from;
  return pattern.exec(text) ?? undefined;
}

/**
 * Replaces each private-key block with `<redacted>`. The spans are the ones one pattern over the whole text
 * matches (a BEGIN header, then the first END header after it), found in one left-to-right pass. A header with
 * no END after it has no END after any later header either, so the pass stops there.
 *
 * One pattern over the whole text rescanned to the end for every unclosed header, so its time grew faster than
 * the text (about 16 times for four times the text, with many headers). This takes time linear in the text.
 */
export function redactPrivateKeyBlocks(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  let opening = matchFrom(PRIVATE_KEY_BEGIN, text, copied);
  while (opening !== undefined) {
    const closing = matchFrom(PRIVATE_KEY_END, text, opening.index + opening[0].length);
    if (closing === undefined) break;
    parts.push(text.slice(copied, opening.index), "<redacted>");
    copied = closing.index + closing[0].length;
    opening = matchFrom(PRIVATE_KEY_BEGIN, text, copied);
  }
  parts.push(text.slice(copied));
  return parts.join("");
}
