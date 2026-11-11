import type { MarkedExtension, Tokens } from "@oh-my-pi/pi-utils/marked";
import { escapeHtml } from "../../lib/format";

/**
 * omp's Hide Secrets placeholder, the AI's stand-in for a saved secret: `$$`, the secret's name in capitals and
 * digits, `_`, a code, a hint of the value's case, `$$` (`$$AMOJWTSECRET_2XUBD7NWOZ1U:L$$`); a secret saved without a
 * name has the code alone.
 */
const PLACEHOLDER = /^\$\$(?:([A-Z0-9]+)_)?([A-Z0-9]{8,})(?::[ULCM])?\$\$/;
/** A placeholder alone on its line, which the math block rule would take for an equation. */
const OWN_LINE = /^ {0,3}(\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{8,}(?::[ULCM])?\$\$)[ \t]*(?:\n|$)/;

function chip(raw: string): string {
  const name = PLACEHOLDER.exec(raw)?.[1];
  const label = name === undefined ? "secret" : name;
  return `<span class="tr-secret" title="${escapeHtml(`A secret: the AI sees ${raw}`)}">🔒 ${escapeHtml(label)}</span>`;
}

/**
 * Hide Secrets' placeholders as a lock and the secret's name rather than as math, which would set the name in italics
 * with its code as a subscript. Registered after the math extension: marked tries the newest extension first. Code
 * spans and blocks keep a placeholder as written.
 */
export const secretPlaceholderExtension: MarkedExtension = {
  extensions: [
    {
      name: "secretPlaceholderLine",
      level: "block",
      tokenizer(source) {
        const match = OWN_LINE.exec(source);
        if (!match) return undefined;
        return { type: "secretPlaceholderLine", raw: match[0], text: match[1] ?? "" };
      },
      renderer: (token) => `<p>${chip((token as Tokens.Generic).text as string)}</p>\n`,
    },
    {
      name: "secretPlaceholder",
      level: "inline",
      startFrom(source, from) {
        const index = source.indexOf("$$", from);
        return index === -1 ? undefined : index;
      },
      tokenizer(source) {
        const match = PLACEHOLDER.exec(source);
        if (!match) return undefined;
        return { type: "secretPlaceholder", raw: match[0] };
      },
      renderer: (token) => chip((token as Tokens.Generic).raw),
    },
  ],
};
