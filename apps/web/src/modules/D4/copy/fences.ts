/**
 * Fenced code blocks in a text part's Markdown source. U1.7 keeps a text part's exact source, so a block
 * is found here with CommonMark's fence rules: a line of three or more backticks or tildes, indented by at
 * most three spaces, closed by a line of the same character at least as long. An unclosed fence runs to
 * the end of the text, as CommonMark has it. Indented code blocks and fences inside other containers are
 * not recognised; the whole text part stays a copy target either way.
 */

export interface FencedBlock {
  /** Position among the fenced blocks of the same text, from 0. Empty blocks count too. */
  readonly index: number;
  /** The first word of the info string, lowercased; "" when there is none. */
  readonly language: string;
  /**
   * The lines between the fences, with the fence's own indentation removed and the final line ending
   * dropped, so a paste ends on the code rather than on a blank line.
   */
  readonly content: string;
}

const OPENING = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const CLOSING = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const SHELL_LANGUAGES: Readonly<Record<string, true>> = {
  bash: true,
  console: true,
  sh: true,
  shell: true,
  shellsession: true,
  zsh: true,
};

/** Whether a fenced block's language names a shell, so its copy target is a command. */
export function isShellLanguage(language: string): boolean {
  return SHELL_LANGUAGES[language] === true;
}

/** Every fenced block in the source, in order. */
export function fencedBlocks(source: string): readonly FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: OpenFence | undefined;
  const close = (): void => {
    if (open === undefined) return;
    blocks.push({
      index: blocks.length,
      language: open.language,
      content: withoutFinalLineEnding(open.content.join("")),
    });
    open = undefined;
  };
  for (const line of linesOf(source)) {
    if (open === undefined) {
      open = openingFence(line.text);
      continue;
    }
    const closing = CLOSING.exec(line.text)?.[1] ?? "";
    if (closing.charAt(0) === open.marker && closing.length >= open.length) {
      close();
      continue;
    }
    open.content.push(unindent(line.raw, open.indent));
  }
  close();
  return blocks;
}

interface Line {
  /** The line without its line ending, for matching fences. */
  readonly text: string;
  /** The line exactly as written, with its line ending, for content. */
  readonly raw: string;
}

interface OpenFence {
  readonly marker: string;
  readonly length: number;
  readonly indent: number;
  readonly language: string;
  readonly content: string[];
}

function openingFence(text: string): OpenFence | undefined {
  const [, indent = "", fence = "", info = ""] = OPENING.exec(text) ?? [];
  // A backtick fence's info string cannot contain a backtick; such a line is inline code, not a fence.
  if (fence === "" || (fence.startsWith("`") && info.includes("`"))) return undefined;
  return {
    marker: fence.charAt(0),
    length: fence.length,
    indent: indent.length,
    language: languageOf(info),
    content: [],
  };
}

function linesOf(source: string): readonly Line[] {
  const lines: Line[] = [];
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const end = newline < 0 ? source.length : newline + 1;
    const raw = source.slice(offset, end);
    lines.push({ text: withoutFinalLineEnding(raw), raw });
    offset = end;
  }
  return lines;
}

function languageOf(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Removes up to `indent` leading spaces, as CommonMark removes the fence's indentation from content. */
function unindent(raw: string, indent: number): string {
  let spaces = 0;
  while (spaces < indent && raw.charAt(spaces) === " ") spaces += 1;
  return raw.slice(spaces);
}

export function withoutFinalLineEnding(text: string): string {
  return text.replace(/\r?\n$/, "");
}
