/**
 * A mention an extension's `@` row puts in the message box as a link (`@[Birthday menu](siyuan:20261118234433-s84elov)`)
 * shows in the box as its label only (`@Birthday menu`); the box keeps what each label stands for, and the message goes
 * out with the links back in place, which the extension reads. A label edited away is plain text again.
 */

const LINK = /@\[([^\]\n]+)\]\(([a-z][a-z0-9+.-]*:[^)\s]+)\)/g;

/** The box with each mention link shortened to its label, the caret kept on the same text, and the labels learned. */
export function shortenMentions(
  text: string,
  caret: number,
  kept: Map<string, string>,
): { readonly text: string; readonly caret: number } {
  let moved = 0;
  const shortened = text.replace(LINK, (link, label: string, _target: string, at: number) => {
    const short = `@${label}`;
    kept.set(short, link);
    if (at + link.length <= caret) moved += link.length - short.length;
    return short;
  });
  return { text: shortened, caret: caret - moved };
}

/** The message as sent: each label still in it as a whole mention (not part of a longer word) back as its link. */
export function expandMentions(text: string, kept: ReadonlyMap<string, string>): string {
  let out = text;
  // Longer labels first, so `@Menu 2` is never read as `@Menu` and a stray "2".
  for (const [short, link] of [...kept].sort((a, b) => b[0].length - a[0].length)) {
    const escaped = short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(^|[^\\S\\n]|\\n)${escaped}(?![\\p{L}\\p{N}_-])`, "gu"),
      `$1${link}`,
    );
  }
  return out;
}
