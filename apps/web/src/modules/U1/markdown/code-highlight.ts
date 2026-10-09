import type { GrammarState, HighlighterCore, ThemedToken } from "shiki/core";
import { type CodeLanguage, loadCodeLanguage } from "./code-language";

/** The theme Shiki registers: its colours are the `--code-token-*` variables, which the token sheet defines. */
export const THEME_NAME = "omp-code";

/**
 * A line this long or longer stays plain. Shiki's cost grows faster than the length of a line (a 500-character
 * `A<` line takes 8.5 s without a limit), and a minified line of 1,000 characters costs about a second.
 */
const MAX_TOKENIZED_LINE = 500;
/**
 * Shiki stops a line after this long and leaves the rest of it plain. That bounds a pathological line: 2,000 characters
 * of `A<` in C++ take 142 s with no limit and about 1 s with this one. A normal line takes a few milliseconds, so it is
 * never cut.
 */
const LINE_TIME_LIMIT_MS = 500;
/**
 * A short sample of common constructs, tokenized once when a grammar loads. The first tokenization compiles the
 * patterns it meets; that cost is paid here, so the first lines of a block on screen are not cut by the time limit.
 */
const PRIMING_SAMPLE = [
  "// A short sample of common constructs.",
  "export function sumValues(values: readonly number[], scale = 2): number {",
  "  let total = 0;",
  "  for (const value of values) total += value * scale; /* scaled */",
  "  return total > 0 ? total : -1;",
  "}",
  "const labels: Record<string, string> = { alpha: 'first', beta: \"second\" };",
  "if (labels.length === 2 && !true) logger.info('done ' + labels.length, [1, 2.5], null);",
  "int main() { return 0; } class Shape<T> { private value: T | null = null; }",
].join("\n");
/** The most characters one render tokenizes itself. A streamed delta changes a few characters; a paste goes to the background. */
const SYNC_CHARACTERS = 2_048;
/** How many recent tokenizations of a block are kept, so a block mounted again with its final text is coloured at once. */
const RECENT_LIMIT = 4;

/**
 * The tokens of one block, and the grammar state after each line. A later text reuses the lines it shares with
 * this one, so only the lines that changed are tokenized again.
 */
export interface Tokenized {
  readonly language: CodeLanguage;
  readonly lines: readonly string[];
  /** One row of tokens per line; a line that has no tokens has an empty row. */
  readonly tokens: readonly (readonly ThemedToken[])[];
  /** The grammar state after each line, which the next line starts from. */
  readonly after: readonly GrammarState[];
}

export interface HighlightRequest {
  readonly language: CodeLanguage;
  readonly lines: readonly string[];
}

// Shiki and its JavaScript regex engine load with the first code block that needs them, so a page with no code
// block never pays for them. A failed load is forgotten, so the next block asks again; a browser that caches a
// failed dynamic import of the same URL keeps the language plain until the page reloads.
let highlighter: Promise<HighlighterCore> | undefined;
/** The highlighter once it has loaded: a change that is cheap to colour is coloured in the render that shows it. */
let readyHighlighter: HighlighterCore | undefined;

/** The shared highlighter, created on first use. Tests use it too, so they run the same Shiki the app does. */
export function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([core, engine]) =>
      core.createHighlighterCore({
        engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
        langs: [],
        themes: [
          // Token colours are the `--code-token-*` variables, which the token sheet defines for light and dark.
          core.createCssVariablesTheme({
            name: THEME_NAME,
            variablePrefix: "--code-",
            fontStyle: true,
          }),
        ],
      }),
  );
  void highlighter.catch(() => {
    highlighter = undefined;
  });
  void highlighter.then(
    (shiki) => {
      readyHighlighter = shiki;
    },
    () => undefined,
  );
  return highlighter;
}

/** Languages whose grammar is loaded and primed: only these are tokenized in a render, so none is partial. */
const primed = new Set<CodeLanguage>();
const languageLoads = new Map<CodeLanguage, Promise<void>>();
export function loadLanguage(language: CodeLanguage): Promise<void> {
  const existing = languageLoads.get(language);
  if (existing !== undefined) return existing;
  const loading = loadCodeLanguage(language).then(async (registrations) => {
    const shiki = await getHighlighter();
    await shiki.loadLanguage(registrations);
    // Shiki applies the theme on the first tokenization, and that first run comes back partial (TypeScript: 11
    // of 13 tokens, its comment merged). This discarded run primes the language, so every real run is complete.
    shiki.codeToTokens(PRIMING_SAMPLE, { lang: language, theme: THEME_NAME });
    primed.add(language);
  });
  languageLoads.set(language, loading);
  void loading.catch(() => {
    languageLoads.delete(language);
  });
  return loading;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** How many lines from the top of `lines` `base` tokenized with the same text, in the same language. */
function reusedLines(
  base: Tokenized | null,
  language: CodeLanguage,
  lines: readonly string[],
): number {
  if (base === null || base.language !== language) return 0;
  const limit = Math.min(base.lines.length, lines.length);
  let index = 0;
  while (index < limit && base.lines[index] === lines[index]) index += 1;
  return index;
}

/** The characters a tokenization of `lines` would process: the lines after the ones `base` can reuse. */
function charactersToTokenize(
  base: Tokenized | null,
  language: CodeLanguage,
  lines: readonly string[],
): number {
  const reused = reusedLines(base, language, lines);
  return lines.slice(reused).reduce((count, line) => count + line.length + 1, 0);
}

/**
 * The tokens of `lines`. The lines `base` shares with them keep their tokens and grammar states; every other line
 * is tokenized from the state its predecessor left, so the result is the same as tokenizing the whole block. A block
 * whose text did not change returns `base` itself.
 */
export function tokenizeLines(
  shiki: HighlighterCore,
  language: CodeLanguage,
  lines: readonly string[],
  base: Tokenized | null,
): Tokenized {
  const reusable = base !== null && base.language === language ? base : null;
  const reused = reusedLines(reusable, language, lines);
  if (reusable !== null && reused === lines.length && reused === reusable.lines.length) {
    return reusable;
  }
  const tokens = reusable?.tokens.slice(0, reused) ?? [];
  const after = reusable?.after.slice(0, reused) ?? [];
  for (let index = reused; index < lines.length; index += 1) {
    const result = shiki.codeToTokensBase(lines[index] ?? "", {
      lang: language,
      theme: THEME_NAME,
      grammarState: after.at(-1),
      tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
      tokenizeTimeLimit: LINE_TIME_LIMIT_MS,
    });
    tokens.push(result[0] ?? []);
    // Every tokenization of a grammar keeps the state it ends in; a missing one would colour later lines wrongly.
    const state = shiki.getLastGrammarState(result);
    if (state === undefined) throw new Error(`No grammar state after line ${index + 1}`);
    after.push(state);
  }
  return { language, lines, tokens, after };
}

/**
 * The tokens of this block in the render that shows it, when that is cheap: the highlighter and the language are
 * loaded, and at most SYNC_CHARACTERS of the text changed. Otherwise undefined, and the caller tokenizes in the
 * background. Returns `base` itself when the text is the one it tokenized.
 */
export function tokenizeNow(
  base: Tokenized | null,
  language: CodeLanguage,
  lines: readonly string[],
): Tokenized | undefined {
  if (base !== null && base.language === language && sameLines(base.lines, lines)) return base;
  const shiki = readyHighlighter;
  if (shiki === undefined || !primed.has(language)) return undefined;
  if (charactersToTokenize(base, language, lines) > SYNC_CHARACTERS) return undefined;
  try {
    return tokenizeLines(shiki, language, lines, base);
  } catch {
    // A grammar that fails leaves the code plain. This runs during render, so it must not throw.
    return undefined;
  }
}

const recent: Tokenized[] = [];

/** Keeps a tokenization, so a block mounted again with the same text is coloured in its first render. */
export function rememberTokenized(result: Tokenized): void {
  const others = recent.filter(
    (entry) => entry.language !== result.language || !sameLines(entry.lines, result.lines),
  );
  others.push(result);
  recent.splice(0, recent.length, ...others.slice(-RECENT_LIMIT));
}

/** A tokenization of exactly this text, if one was remembered; otherwise null. */
export function recallTokenized(
  language: CodeLanguage,
  lines: readonly string[],
): Tokenized | null {
  return (
    recent.find((entry) => entry.language === language && sameLines(entry.lines, lines)) ?? null
  );
}

/**
 * The background run of one block: loads the language, tokenizes the lines from the block's last background
 * result, and hands the result to `apply`. A grammar that fails to load leaves the block plain, so the run
 * never rejects.
 */
export function createBackgroundRun(
  apply: (result: Tokenized) => void,
): (request: HighlightRequest) => Promise<void> {
  let base: Tokenized | null = null;
  return async ({ language, lines }) => {
    const result = await highlightInBackground(language, lines, base);
    if (result === undefined) return;
    base = result;
    apply(result);
  };
}

async function highlightInBackground(
  language: CodeLanguage,
  lines: readonly string[],
  base: Tokenized | null,
): Promise<Tokenized | undefined> {
  try {
    await loadLanguage(language);
    const shiki = await getHighlighter();
    return tokenizeLines(shiki, language, lines, base);
  } catch {
    // A grammar that fails to load leaves its code as plain text, which is still readable.
    return undefined;
  }
}
