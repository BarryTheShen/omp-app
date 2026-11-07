import type { MarkedExtension, TokenizerThis, Tokens } from "@oh-my-pi/pi-utils/marked";
import {
	type MathSpan,
	mathBlockInContext,
	mathSpanInContext,
	mathStartIndex,
} from "@oh-my-pi/pi-utils/math-delimiters";
import { renderToString } from "katex";
import { escapeHtml } from "../../lib/format";

/**
 * A backtick between the delimiters means the run is prose that merely looks
 * like math (`$x `code` y$`): KaTeX cannot express a code span, so typesetting
 * would swallow it and print an error instead.
 */
function typesettable(span: MathSpan): boolean {
	return !span.body.includes("`");
}

/** An own-line display opener: `$$` or `\[` alone on its line, after up to 3 spaces. */
const OPENER_LINE = /^ {0,3}(?:\$\$|\\\[)[ \t]*\n?$/;

/** The line of `source` that starts at `start`, with its line break; "" past the end. */
function lineAt(source: string, start: number): string {
	if (start >= source.length) return "";
	const end = source.indexOf("\n", start);
	return end === -1 ? source.slice(start) : source.slice(start, end + 1);
}

/**
 * Whether the lexer may start a block at `line`, with `next` under it: the core's `isBlockStart`, which
 * `@oh-my-pi/pi-utils/marked` does not export, read wider where it is unsure and never narrower, so a paragraph
 * ended here never runs past one the core would have ended.
 */
function mayStartBlock(line: string, next: string): boolean {
	if (line.trim() === "") return true;
	if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true; // a fence
	if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true; // a heading
	if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*\n?$/.test(line)) return true; // a rule
	if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/.test(line)) return true; // a list item
	if (/^ {0,3}[>[<]/.test(line)) return true; // a quote, a link definition, HTML
	if (/^ {4}\S/.test(line)) return true; // indented code
	if (/^ {0,3}(?:=+|-+)[ \t]*\n?$/.test(next)) return true; // a heading's underline under it
	return line.includes("|") && /^[\s|:-]*-[\s|:-]*$/.test(next); // a table's head
}

/**
 * The paragraph right above an own-line display block, ended at the block's opener (#2840). A paragraph runs on
 * until a line that starts a block, and `$$` and `\[` start none, so an equation written under its line of text
 * joined that paragraph, and a line of it that Markdown reads as a block start ended the paragraph there: a lone
 * `=` made the line above it a heading, `- x` a list item. Ended at the opener, the paragraph leaves the block
 * rule to take the whole equation at the next block start. Anything the core would not make a paragraph of, and a
 * paragraph with no closed block under it, are left to the core.
 */
function paragraphAboveMath(context: TokenizerThis, source: string): Tokens.Generic | undefined {
	const first = lineAt(source, 0);
	if (/^ {4}/.test(first) || OPENER_LINE.test(first) || mayStartBlock(first, lineAt(source, first.length)))
		return undefined;
	let start = first.length;
	for (;;) {
		const line = lineAt(source, start);
		if (line === "") return undefined;
		if (OPENER_LINE.test(line) && mathBlockInContext(context, source.slice(start))) {
			const raw = source.slice(0, start);
			const text = raw.slice(0, -1);
			return { type: "paragraph", raw, text, tokens: context.lexer.inline(text, []) };
		}
		// As in the core, a line indented as code goes on with the paragraph it is attached to.
		const indented = line.trim() !== "" && /^ {4}/.test(line);
		if (!indented && mayStartBlock(line, lineAt(source, start + line.length))) return undefined;
		start += line.length;
	}
}

function renderMath(token: Tokens.Generic): string | false {
	if (token.type !== "math" || typeof token.text !== "string" || typeof token.display !== "boolean") return false;
	try {
		const math = renderToString(token.text, {
			displayMode: token.display,
			// KaTeX's drawn output with its MathML beside it, hidden, for screen
			// readers. MathML alone left Chromium without `\boxed`'s frame and with
			// a small `\underbrace` brace. katex.min.css (main.tsx) has the fonts as
			// files of their own, each fetched the first time a formula uses it.
			output: "htmlAndMathml",
			throwOnError: false,
			// `trust: false` refuses \href, \htmlClass, \includegraphics.
			strict: false,
			trust: false,
		});
		// A display equation gets a wrapper to scroll in (`.tr-math`), so a wide one
		// scrolls on its own instead of widening the message.
		return token.display ? `<span class="tr-math">${math}</span>` : math;
	} catch {
		// KaTeX threw outside its own error handling (e.g. macro expansion limit):
		// show the source rather than let one span blank the whole message.
		return escapeHtml(typeof token.raw === "string" ? token.raw : token.text);
	}
}

/**
 * Renders LaTeX in transcript Markdown: `$…$` and `\(…\)` inline, `$$…$$` and
 * `\[…\]` in display mode, plus own-line `$$`/`\[` blocks. Delimiters and the
 * scan hint come from `@oh-my-pi/pi-utils/math-delimiters`, so this renderer and
 * the TUI agree on what counts as math; only presentation policy lives here.
 *
 * One limit follows from that shared behavior, matching the TUI: a rejected
 * opener hides later spans on its line ("it costs $5, and the growth is $x^2$"
 * typesets nothing, since marked drops a start hint at its own position). An
 * own-line block right under a line of text ends that line's paragraph
 * (`paragraphAboveMath`), so it is a block as it is after a blank line.
 */
export const mathExtension: MarkedExtension = {
	extensions: [
		{
			name: "math",
			level: "block",
			// No `start` hint: this parser probes block extensions only at a block
			// boundary and never consults their hints.
			tokenizer(source) {
				const block = mathBlockInContext(this, source);
				if (!block) return undefined;
				return { type: "math", raw: block.raw, text: block.body, display: true };
			},
			renderer: renderMath,
		},
		{
			// Before the block rule: it hands that rule the equation at the next block start.
			name: "mathLeadIn",
			level: "block",
			tokenizer(source) {
				return paragraphAboveMath(this, source);
			},
		},
		{
			name: "math",
			level: "inline",
			startFrom: mathStartIndex,
			tokenizer(source) {
				const span = mathSpanInContext(this, source);
				if (!span || !typesettable(span)) return undefined;
				return { type: "math", raw: source.slice(0, span.end), text: span.body, display: span.display };
			},
			renderer: renderMath,
		},
	],
};
