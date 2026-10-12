/**
 * Math in Markdown text, in the forms models write: `$...$`, `$$...$$`, `\(...\)` and `\[...\]`. A formula is one token
 * of the text parser, so Markdown does not read inside it, and code spans and code blocks are never math: the parser
 * meets them first, and a backtick cannot be formula text, so a formula never closes on a code span's dollar sign. A
 * dollar sign that cannot close a formula, or that a price would open, is text, so `$5 and $10` stays as written. A
 * formula still being written has no closing delimiter yet, so it is text until that arrives.
 */
import {
  asciiDigit,
  markdownLineEnding,
  markdownLineEndingOrSpace,
} from "micromark-util-character";
import type {
  Code,
  Construct,
  Effects,
  Extension,
  State,
  Token,
  TokenizeContext,
} from "micromark-util-types";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    /** A whole formula, its delimiters included. */
    mathInline: "mathInline";
    /** A delimiter, or a run of dollars or a backslash that may still turn out to be formula text. */
    mathInlineSequence: "mathInlineSequence";
    /** The TeX between the delimiters, a run of characters without a line break. */
    mathInlineData: "mathInlineData";
  }
}

const BACKTICK = 96;
const DOLLAR = 36;
const BACKSLASH = 92;
const LEFT_PAREN = 40;
const RIGHT_PAREN = 41;
const LEFT_BRACKET = 91;
const RIGHT_BRACKET = 93;

/*
 * Inside a formula every character is consumed inside a token of its own kind, as micromark requires: a line break is a
 * `lineEnding` token, the characters between breaks are `mathInlineData`. A run of dollars or a backslash is first read
 * as a `mathInlineSequence`, and becomes `mathInlineData` when it turns out not to close the formula.
 */

/** `$...$` and `$$...$$`. The closing run is as long as the opening one. */
const dollarMath: Construct = {
  name: "mathDollar",
  previous: previousDollar,
  tokenize: tokenizeDollarMath,
};

/** A dollar that continues a run of dollars cannot open a formula; an escaped one (`\$`) can. */
function previousDollar(this: TokenizeContext, code: Code): boolean {
  return code !== DOLLAR || this.events.at(-1)?.[1].type === "characterEscape";
}

function tokenizeDollarMath(effects: Effects, ok: State, nok: State): State {
  let size = 0; // dollars in the opening run
  let run = 0; // dollars in the run being read
  let before: Code = null; // the character before that run
  let last: Code = null; // the character read last
  let content = false; // whether the formula has anything but spaces yet
  let sequence: Token | undefined; // the run of dollars being read
  return start;

  function start(code: Code): State | undefined {
    effects.enter("mathInline");
    effects.consume(code);
    size = 1;
    return opening;
  }

  function opening(code: Code): State | undefined {
    if (code === DOLLAR) {
      effects.consume(code);
      size += 1;
      return opening;
    }
    if (size > 2) return nok(code);
    // A single dollar opens only before something that is not a space: `$5` can, `$ 5` cannot.
    if (size === 1 && (code === null || markdownLineEndingOrSpace(code))) return nok(code);
    last = DOLLAR;
    return inside(code);
  }

  function inside(code: Code): State | undefined {
    if (code === null || code === BACKTICK) return nok(code);
    if (code === DOLLAR) {
      before = last;
      run = 0;
      sequence = effects.enter("mathInlineSequence");
      return closingRun(code);
    }
    if (markdownLineEnding(code)) return lineEnding(code);
    if (code === BACKSLASH) {
      effects.enter("mathInlineData");
      effects.consume(code);
      content = true;
      return escaped;
    }
    effects.enter("mathInlineData");
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (code === BACKTICK) return nok(code);
    if (code === null || code === DOLLAR || code === BACKSLASH || markdownLineEnding(code)) {
      effects.exit("mathInlineData");
      return inside(code);
    }
    effects.consume(code);
    last = code;
    if (!markdownLineEndingOrSpace(code)) content = true;
    return data;
  }

  // The character after a backslash belongs to the TeX: `\$` is a dollar sign in the formula, `\\` a line break.
  function escaped(code: Code): State | undefined {
    if (code === null || markdownLineEnding(code)) {
      effects.exit("mathInlineData");
      return inside(code);
    }
    effects.consume(code);
    effects.exit("mathInlineData");
    last = code;
    return inside;
  }

  function lineEnding(code: Code): State | undefined {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    last = code;
    return inside;
  }

  function closingRun(code: Code): State | undefined {
    if (code === DOLLAR) {
      effects.consume(code);
      run += 1;
      return closingRun;
    }
    const closes =
      run === size &&
      content &&
      (size === 2 || (!markdownLineEndingOrSpace(before) && !asciiDigit(code)));
    if (closes) {
      effects.exit("mathInlineSequence");
      effects.exit("mathInline");
      return ok(code);
    }
    // A price, or the start of another formula, ends this one unread: in `$5 and $E = mc^2$`, `$5` stays text.
    const opensAnother =
      size === 1 &&
      run === 1 &&
      markdownLineEndingOrSpace(before) &&
      code !== null &&
      !markdownLineEndingOrSpace(code);
    if (opensAnother) return nok(code);
    // The run is part of the formula after all: its dollars are TeX.
    if (sequence !== undefined) sequence.type = "mathInlineData";
    effects.exit("mathInlineData");
    last = DOLLAR;
    content = true;
    return inside(code);
  }
}

/** `\(...\)` and `\[...\]`. `\)` or `\]` ends the formula; `\\` and other escapes are the TeX's own. */
const parenMath: Construct = { name: "mathParen", tokenize: tokenizeParenMath };

function tokenizeParenMath(effects: Effects, ok: State, nok: State): State {
  let closer: Code = null;
  let content = false;
  let backslash: Token | undefined; // the backslash being read, which may begin the closer
  return start;

  function start(code: Code): State | undefined {
    effects.enter("mathInline");
    effects.consume(code);
    return opening;
  }

  function opening(code: Code): State | undefined {
    if (code !== LEFT_PAREN && code !== LEFT_BRACKET) return nok(code);
    closer = code === LEFT_PAREN ? RIGHT_PAREN : RIGHT_BRACKET;
    effects.consume(code);
    return inside;
  }

  function inside(code: Code): State | undefined {
    if (code === null || code === BACKTICK) return nok(code);
    if (markdownLineEnding(code)) return lineEnding(code);
    if (code === BACKSLASH) {
      backslash = effects.enter("mathInlineSequence");
      effects.consume(code);
      return afterBackslash;
    }
    effects.enter("mathInlineData");
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (code === BACKTICK) return nok(code);
    if (code === null || code === BACKSLASH || markdownLineEnding(code)) {
      effects.exit("mathInlineData");
      return inside(code);
    }
    effects.consume(code);
    if (!markdownLineEndingOrSpace(code)) content = true;
    return data;
  }

  function lineEnding(code: Code): State | undefined {
    effects.enter("lineEnding");
    effects.consume(code);
    effects.exit("lineEnding");
    return inside;
  }

  function afterBackslash(code: Code): State | undefined {
    if (code === closer) {
      if (!content) return nok(code);
      effects.consume(code);
      effects.exit("mathInlineSequence");
      effects.exit("mathInline");
      return ok;
    }
    // Not the closer: the backslash and the character after it are the TeX's own, so they are TeX data.
    if (backslash !== undefined) backslash.type = "mathInlineData";
    content = true;
    if (code === null || markdownLineEnding(code)) {
      effects.exit("mathInlineData");
      return inside(code);
    }
    effects.consume(code);
    effects.exit("mathInlineData");
    return inside;
  }
}

/** A backslash before `(` or `[` that opens no formula stays a backslash, so an unfinished `\(` shows as written. */
const backslashText: Construct = { name: "mathBackslash", tokenize: tokenizeBackslashText };

function tokenizeBackslashText(effects: Effects, ok: State, nok: State): State {
  return start;

  function start(code: Code): State | undefined {
    effects.enter("data");
    effects.consume(code);
    return next;
  }

  function next(code: Code): State | undefined {
    if (code !== LEFT_PAREN && code !== LEFT_BRACKET) return nok(code);
    effects.exit("data");
    return ok(code);
  }
}

/** The micromark syntax extension: the parser reads the four forms as `mathInline` tokens. */
export function mathSyntax(): Extension {
  return { text: { [DOLLAR]: dollarMath, [BACKSLASH]: [parenMath, backslashText] } };
}
