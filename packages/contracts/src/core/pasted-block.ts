/**
 * The block a pasted text travels in, inside a person's message: omp's `<attachment>` wrapper (omp v18.9.1
 * `modes/controllers/input-controller.ts:216-218`). The composer writes it (`withPastedText`), the transcript splits it
 * back out for display (`splitPastedBlocks`), and the server reads a chat's first prompt from it (`firstPromptTextOf`). All
 * read the constants below, so they cannot drift apart.
 */
const BLOCK_TAG = { open: "<attachment>", close: "</attachment>" } as const;
/** How a block opens and closes: each tag on a line of its own, around the text. */
const BLOCK = { open: `${BLOCK_TAG.open}\n`, close: `\n${BLOCK_TAG.close}` } as const;
/** Between the typed text and each block, and between two blocks: the join a message's parts are written with. */
export const MESSAGE_PART_SEPARATOR = "\n\n";

/** The number of lines a text has, as a pasted-text chip's name counts them (an empty text has none). */
export function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

/** One pasted text as its block: the text between the wrapper's tags, each tag on a line of its own. */
export function wrapPastedBlock(text: string): string {
  return `${BLOCK.open}${text}${BLOCK.close}`;
}

/**
 * A part of a person's message: the typed text, or one pasted block with its number among the message's blocks. `start`
 * is where the part begins in the message, so no two parts share it.
 */
export type MessageSegment =
  | { readonly kind: "text"; readonly text: string; readonly start: number }
  | {
      readonly kind: "pasted";
      readonly text: string;
      readonly sequence: number;
      readonly lines: number;
      readonly start: number;
    };

/** One opening or closing tag, where it starts in the message. */
interface Tag {
  readonly at: number;
  readonly isOpen: boolean;
}

/** A wrapper's opening and closing tags, with their places among all the message's tags. */
interface Pair {
  readonly open: Tag;
  readonly close: Tag;
  readonly openIndex: number;
  readonly closeIndex: number;
}

interface Block {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function tagsOf(message: string): Tag[] {
  return [...message.matchAll(/<\/?attachment>/g)].map((match) => ({
    at: match.index ?? 0,
    isOpen: match[0] === BLOCK_TAG.open,
  }));
}

/**
 * Pairs each closing tag with the nearest unclosed opening tag before it. An opening tag never closed, and a closing tag
 * with nothing to close, pair with nothing and stay plain text.
 */
function pairsOf(tags: readonly Tag[]): Pair[] {
  const pairs: Pair[] = [];
  const unclosed: { readonly tag: Tag; readonly index: number }[] = [];
  tags.forEach((tag, index) => {
    if (tag.isOpen) {
      unclosed.push({ tag, index });
      return;
    }
    const opened = unclosed.pop();
    if (opened !== undefined) {
      pairs.push({
        open: opened.tag,
        close: tag,
        openIndex: opened.index,
        closeIndex: index,
      });
    }
  });
  return pairs;
}

/**
 * Whether a pair is a candidate block: no tag sits between its tags (a nested or stray tag inside it leaves it plain),
 * and no other pair holds it (a block nested in a wrapper is plain, as the wrapper around it is).
 */
function isCandidate(pair: Pair, pairs: readonly Pair[]): boolean {
  if (pair.closeIndex !== pair.openIndex + 1) return false;
  return !pairs.some(
    (outer) => outer.openIndex < pair.openIndex && outer.closeIndex > pair.closeIndex,
  );
}

/** Whether the block that opens at `start` starts the message, or follows the separator. */
function followsSeparator(message: string, start: number): boolean {
  if (start === 0) return true;
  return (
    start >= MESSAGE_PART_SEPARATOR.length &&
    message.startsWith(MESSAGE_PART_SEPARATOR, start - MESSAGE_PART_SEPARATOR.length)
  );
}

/**
 * The block a candidate pair makes, if it is in the exact layout the writer writes: the opening tag starts the message or
 * follows the separator and is followed by a line break, the closing tag is on a line of its own, and the message ends or
 * a separator follows it.
 */
function blockOf(message: string, open: Tag, close: Tag): Block | undefined {
  if (!followsSeparator(message, open.at)) return undefined;
  if (message[open.at + BLOCK_TAG.open.length] !== "\n") return undefined;
  const contentStart = open.at + BLOCK.open.length;
  if (close.at - 1 < contentStart || message[close.at - 1] !== "\n") return undefined;
  const end = close.at + BLOCK_TAG.close.length;
  if (end !== message.length && !message.startsWith(MESSAGE_PART_SEPARATOR, end)) return undefined;
  return { start: open.at, end, text: message.slice(contentStart, close.at - 1) };
}

/**
 * Splits a person's message into its typed text and its pasted blocks, for display only: the message itself is not
 * changed, so copy and edit still get the whole text. A message with no block in exact form is one text segment.
 */
export function splitPastedBlocks(message: string): readonly MessageSegment[] {
  const pairs = pairsOf(tagsOf(message));
  const blocks: Block[] = [];
  for (const pair of pairs) {
    if (!isCandidate(pair, pairs)) continue;
    const block = blockOf(message, pair.open, pair.close);
    if (block !== undefined) blocks.push(block);
  }
  blocks.sort((first, second) => first.start - second.start);
  if (blocks.length === 0) return [{ kind: "text", text: message, start: 0 }];

  const segments: MessageSegment[] = [];
  let textStart = 0;
  blocks.forEach((block, index) => {
    // The separator before a block is the message's join, not part of the typed text in front of it.
    const textEnd = block.start === 0 ? 0 : block.start - MESSAGE_PART_SEPARATOR.length;
    if (textEnd > textStart)
      segments.push({ kind: "text", text: message.slice(textStart, textEnd), start: textStart });
    segments.push({
      kind: "pasted",
      text: block.text,
      sequence: index + 1,
      lines: lineCount(block.text),
      start: block.start,
    });
    textStart =
      block.end === message.length ? block.end : block.end + MESSAGE_PART_SEPARATOR.length;
  });
  if (textStart < message.length)
    segments.push({ kind: "text", text: message.slice(textStart), start: textStart });
  return segments;
}

/**
 * The words a chat lists as its first prompt: the typed text, its parts joined by a space, when there is some. Otherwise
 * the first line with words in the message's pasted texts, so a message that is only a pasted text lists that text and
 * never omp's wrapper. A block that is not in exact form is typed text, as the transcript shows it. Empty when there is
 * neither.
 */
export function firstPromptTextOf(message: string): string {
  const segments = splitPastedBlocks(message);
  const typed = segments
    .flatMap((segment) => (segment.kind === "text" ? [segment.text] : []))
    .join(" ");
  if (typed.trim().length > 0) return typed;
  for (const segment of segments) {
    if (segment.kind !== "pasted") continue;
    const line = segment.text
      .split(/\r\n|\r|\n/)
      .map((text) => text.trim())
      .find((text) => text.length > 0);
    if (line !== undefined) return line;
  }
  return "";
}
