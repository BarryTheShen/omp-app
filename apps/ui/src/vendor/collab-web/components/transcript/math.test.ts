import { describe, expect, test } from "vitest";
import { renderStreamingMarkdown } from "./Markdown";

/** The transcript's markup for a whole text, as a finished message gets it. */
const render = (text: string): string => renderStreamingMarkdown(text, { source: "", html: "" }).html;

/** The TeX of each display equation in `html`, as KaTeX keeps it in the MathML's annotation (HTML-escaped). */
const displayMath = (html: string): string[] =>
	[...html.matchAll(/<math[^>]*display="block"[\s\S]*?<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)].map(
		match =>
			match[1]!
				.replaceAll("&lt;", "<")
				.replaceAll("&gt;", ">")
				.replaceAll("&quot;", '"')
				.replaceAll("&#x27;", "'")
				.replaceAll("&amp;", "&"),
	);

// A reply as omp wrote it (#2840): the equation's `$$` right under its line of text, and a lone `=` in it.
const REPLY = [
	"**The key move: treat the sample average as an estimate of the population average.** Match them:",
	"$$",
	"\\underbrace{\\bar X}_{\\text{sample mean}}",
	"=",
	"\\underbrace{\\widehat\\theta\\sqrt{\\frac{\\pi}{2}}}_{\\text{model's mean using our estimated parameter}}.",
	"$$",
	"",
	"**3. Solve for the estimate $\\widehat\\theta$.**",
	"",
	"For example, if your sample average is $10$, then",
	"$$",
	"\\widehat\\theta=\\frac{10}{1.2533}\\approx 7.98.",
	"$$",
].join("\n");

describe("display math right under a line of text", () => {
	test("is typeset whole, even with a line Markdown reads as a heading's underline (#2840)", () => {
		const html = render(REPLY);
		expect(displayMath(html)).toEqual([
			"\\underbrace{\\bar X}_{\\text{sample mean}}\n=\n\\underbrace{\\widehat\\theta\\sqrt{\\frac{\\pi}{2}}}_{\\text{model's mean using our estimated parameter}}.",
			"\\widehat\\theta=\\frac{10}{1.2533}\\approx 7.98.",
		]);
		expect(html).not.toMatch(/<h[1-6]/);
		expect(html).not.toContain("$$");
		// The line above an equation stays its own paragraph.
		expect(html).toContain("Match them:</p>");
		expect(html).toContain("then</p>");
	});

	test("with \\[ \\] and a line Markdown reads as a list item", () => {
		const html = render("so the difference is\n\\[\nf(x)\n- g(x) = 0\n\\]\nfor every x.");
		expect(displayMath(html)).toEqual(["f(x)\n- g(x) = 0"]);
		expect(html).not.toContain("<li");
		expect(html).toContain("so the difference is</p>");
		expect(html).toContain("for every x.</p>");
	});

	test("inside a list item, which stays as tight as the list it is in", () => {
		const html = render("1. Match them:\n   $$\n   a\n   =\n   b\n   $$\n2. Solve for it.");
		expect(displayMath(html)).toEqual(["a\n=\nb"]);
		expect(html).not.toMatch(/<h[1-6]/);
		expect(html.match(/<li>/g)).toHaveLength(2);
		expect(html).not.toContain("<p>");
	});

	test("in a fenced code block it stays code", () => {
		const html = render("```\nMatch them:\n$$\na\n=\nb\n$$\n```");
		expect(displayMath(html)).toEqual([]);
		expect(html).toContain("Match them:\n$$\na\n=\nb\n$$");
	});

	test("streams to the same markup as the whole text, at every length", () => {
		let prefix = { source: "", html: "" };
		for (let length = 1; length <= REPLY.length; length++) {
			const text = REPLY.slice(0, length);
			const streamed = renderStreamingMarkdown(text, prefix);
			prefix = streamed.prefix;
			expect(streamed.html, `after ${length} characters`).toBe(render(text));
		}
	});
});
