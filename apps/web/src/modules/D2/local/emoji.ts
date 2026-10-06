import type {
  PromptExpansionResult,
  TextRange,
  TriggerCandidate,
  TriggerPosition,
  TriggerSearchResult,
} from "../contract";
import emojiBuckets from "./emojis.json";
import type { LocalProvider } from "./provider";

/**
 * Mirrors omp v18.6.1's emoji autocomplete boundary and inline replacement rules:
 * `src/modes/emoji-autocomplete.ts:131-170,232-322` as recorded in `research/modules/D2.md`.
 * The checked-in bucket is the offline shortcode set consumed by that implementation.
 */
export interface EmojiTriggerMatch {
  readonly prefix: string;
  readonly query: string;
  readonly range: TextRange;
}

export interface EmojiInlineReplacement {
  readonly replaceLength: number;
  readonly insert: string;
}

const MAX_SUGGESTIONS = 12;
const EMOTICONS: readonly (readonly [string, string])[] = [
  [":'-(", "😢"],
  [">:-(", "😠"],
  [":-)", "🙂"],
  [":-(", "🙁"],
  [":-D", "😃"],
  [":-P", "😛"],
  [":-p", "😛"],
  [":-O", "😮"],
  [":-o", "😮"],
  [":-|", "😐"],
  [":-/", "😕"],
  [":-\\", "😕"],
  [":-*", "😘"],
  [";-)", "😉"],
  [";-P", "😜"],
  [":')", "🥲"],
  [":'D", "😂"],
  [":'(", "😢"],
  ["</3", "💔"],
  [">:(", "😠"],
  ["B-)", "😎"],
  ["8-)", "😎"],
  ["o.O", "😳"],
  ["O.o", "😳"],
  [":)", "🙂"],
  [":(", "🙁"],
  [":D", "😃"],
  [":P", "😛"],
  [":p", "😛"],
  [":O", "😮"],
  [":o", "😮"],
  [":|", "😐"],
  [":/", "😕"],
  [":\\", "😕"],
  [":*", "😘"],
  [";)", "😉"],
  [":3", "😺"],
  ["<3", "❤️"],
  ["xD", "😆"],
  ["XD", "😆"],
  ["B)", "😎"],
  ["8)", "😎"],
] as const;

const BUCKETS = emojiBuckets as unknown as Readonly<Record<string, readonly [string, string][]>>;

function isNameCharCode(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x2b ||
    code === 0x2d
  );
}

function hasLeftBoundary(text: string, colonIndex: number): boolean {
  if (colonIndex === 0) return true;
  const code = text.charCodeAt(colonIndex - 1);
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x28 ||
    code === 0x5b ||
    code === 0x7b ||
    code === 0x3e
  );
}

/** Returns true for inline-code spans and fenced-code blocks at a text position. */
export function isInsideCode(text: string, position: number): boolean {
  const limit = Math.max(0, Math.min(position, text.length));
  let fenced = false;
  let inlineDelimiter = 0;
  let lineStart = true;
  for (let index = 0; index < limit; ) {
    const character = text[index];
    if (lineStart) {
      let spaces = index;
      while (spaces < limit && (text[spaces] === " " || text[spaces] === "\t")) spaces += 1;
      if (text.slice(spaces, spaces + 3) === "```") {
        fenced = !fenced;
        index = spaces + 3;
        lineStart = false;
        continue;
      }
      lineStart = false;
    }
    if (character === "\n") {
      lineStart = true;
      index += 1;
      continue;
    }
    if (!fenced && character === "`") {
      let run = 1;
      while (index + run < limit && text[index + run] === "`") run += 1;
      if (run === 1) inlineDelimiter = inlineDelimiter === 0 ? 1 : 0;
      index += run;
      continue;
    }
    index += 1;
  }
  return fenced || inlineDelimiter !== 0;
}

function extractTrigger(textBeforeCursor: string): EmojiTriggerMatch | null {
  if (isInsideCode(textBeforeCursor, textBeforeCursor.length)) return null;
  let index = textBeforeCursor.length;
  while (index > 0 && isNameCharCode(textBeforeCursor.charCodeAt(index - 1))) index -= 1;
  if (index === 0 || textBeforeCursor.charCodeAt(index - 1) !== 0x3a) return null;
  const colonIndex = index - 1;
  if (!hasLeftBoundary(textBeforeCursor, colonIndex)) return null;
  const query = textBeforeCursor.slice(index).toLocaleLowerCase();
  if (query.length === 0) return null;
  return {
    prefix: `:${textBeforeCursor.slice(index)}`,
    query,
    range: { start: colonIndex, end: textBeforeCursor.length },
  };
}

function lowerBound(entries: readonly (readonly [string, string])[], target: string): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((entries[middle]?.[0] ?? "") < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function bucketEntries(query: string): readonly (readonly [string, string])[] {
  return BUCKETS[query[0] ?? ""] ?? [];
}

function emojiCandidates(query: string): readonly TriggerCandidate[] {
  const normalized = query.toLocaleLowerCase();
  const candidates: TriggerCandidate[] = [];
  const wanted = `:${normalized}`;
  for (const [pattern, character] of EMOTICONS) {
    if (candidates.length >= MAX_SUGGESTIONS) break;
    if (pattern.length >= wanted.length && pattern.toLocaleLowerCase().startsWith(wanted)) {
      candidates.push({
        id: `emoji:emoticon:${pattern}`,
        kind: "emoji",
        source: "client",
        label: `${character}  ${pattern}`,
        insertText: character,
        metadata: { pattern, character },
      });
    }
  }
  const entries = bucketEntries(normalized);
  for (
    let index = lowerBound(entries, normalized);
    index < entries.length && candidates.length < MAX_SUGGESTIONS;
    index += 1
  ) {
    const entry = entries[index];
    if (!entry?.[0].startsWith(normalized)) break;
    const [name, character] = entry;
    candidates.push({
      id: `emoji:${name}`,
      kind: "emoji",
      source: "client",
      label: `${character}  :${name}:`,
      insertText: character,
      metadata: { name, character },
    });
  }
  return candidates;
}

export function createEmojiProvider(): LocalProvider {
  const searchTyped = async (
    query: string,
    position?: TriggerPosition,
  ): Promise<TriggerSearchResult> => {
    const candidates = emojiCandidates(query).map((candidate) =>
      position ? { ...candidate, position } : candidate,
    );
    return candidates.length === 0
      ? { state: "ready", candidates: [] }
      : { state: "ready", candidates };
  };
  return {
    trigger: ":",
    kind: "emoji",
    source: "client",
    search: async (query) => (await searchTyped(query)).candidates,
    searchTyped,
  };
}

function replaceRange(
  text: string,
  range: TextRange,
  replacement: string,
): { readonly text: string; readonly cursor: number } {
  return {
    text: `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`,
    cursor: range.start + replacement.length,
  };
}

export function expandEmoji(
  text: string,
  match: EmojiTriggerMatch,
  candidate: TriggerCandidate,
): PromptExpansionResult {
  if (isInsideCode(text, match.range.start)) {
    return {
      kind: "error",
      error: {
        code: "invalid_args",
        message: "Emoji expansion is disabled inside code.",
        retryable: false,
      },
      replace: match.range,
      preserveText: true,
    };
  }
  const replacement = candidate.insertText ?? "";
  const replaced = replaceRange(text, match.range, replacement);
  return {
    kind: "expanded",
    text: replaced.text,
    replace: match.range,
    cursor: replaced.cursor,
    attachmentRefs: [],
  };
}

function isEmoticonTerminator(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function exactEmoji(name: string): string | undefined {
  const entries = BUCKETS[name[0] ?? ""] ?? [];
  const index = lowerBound(entries, name);
  const entry = entries[index];
  return entry?.[0] === name ? entry[1] : undefined;
}

function tryShortcodeInlineReplace(textBeforeCursor: string): EmojiInlineReplacement | null {
  const length = textBeforeCursor.length;
  if (
    length === 0 ||
    textBeforeCursor.charCodeAt(length - 1) !== 0x3a ||
    isInsideCode(textBeforeCursor, length - 1)
  )
    return null;
  let nameStart = length - 1;
  while (nameStart > 0 && isNameCharCode(textBeforeCursor.charCodeAt(nameStart - 1)))
    nameStart -= 1;
  if (
    nameStart === length - 1 ||
    nameStart === 0 ||
    textBeforeCursor.charCodeAt(nameStart - 1) !== 0x3a
  )
    return null;
  if (!hasLeftBoundary(textBeforeCursor, nameStart - 1)) return null;
  const name = textBeforeCursor.slice(nameStart, length - 1).toLocaleLowerCase();
  const character = exactEmoji(name);
  return character ? { replaceLength: name.length + 2, insert: character } : null;
}

function tryEmoticonInlineReplace(textBeforeCursor: string): EmojiInlineReplacement | null {
  const length = textBeforeCursor.length;
  if (length < 2 || !isEmoticonTerminator(textBeforeCursor.charCodeAt(length - 1))) return null;
  const terminator = textBeforeCursor[length - 1];
  const end = length - 1;
  for (const [pattern, character] of EMOTICONS) {
    const start = end - pattern.length;
    if (start < 0 || textBeforeCursor.slice(start, end) !== pattern) continue;
    if (isInsideCode(textBeforeCursor, start)) continue;
    if (start > 0 && !hasLeftBoundary(textBeforeCursor, start)) continue;
    return { replaceLength: pattern.length + 1, insert: `${character}${terminator}` };
  }
  return null;
}

export function tryEmojiInlineReplace(textBeforeCursor: string): EmojiInlineReplacement | null {
  return tryShortcodeInlineReplace(textBeforeCursor) ?? tryEmoticonInlineReplace(textBeforeCursor);
}

export function expandEmoticons(text: string): string {
  if (text.length < 2) return text;
  let output = "";
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (!isInsideCode(text, index) && (index === 0 || hasLeftBoundary(text, index))) {
      let matched = false;
      for (const [pattern, character] of EMOTICONS) {
        if (!text.startsWith(pattern, index)) continue;
        const end = index + pattern.length;
        if (end !== text.length && !isEmoticonTerminator(text.charCodeAt(end))) continue;
        output += text.slice(cursor, index) + character;
        cursor = end;
        index = end;
        matched = true;
        break;
      }
      if (matched) continue;
    }
    index += 1;
  }
  return cursor === 0 ? text : output + text.slice(cursor);
}

export function isEmojiPrefix(prefix: string): boolean {
  return prefix.startsWith(":");
}

export function detectEmojiTrigger(
  text: string,
  cursorPosition = text.length,
): EmojiTriggerMatch | null {
  const before = text.slice(0, Math.max(0, Math.min(cursorPosition, text.length)));
  return extractTrigger(before);
}
