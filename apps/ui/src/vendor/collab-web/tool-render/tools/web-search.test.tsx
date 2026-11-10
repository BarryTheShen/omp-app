import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { ToolResultLike } from "../types";
import { webSearchRenderer } from "./web-search";

const { Body } = webSearchRenderer;
if (!Body) throw new Error("the web search renderer has no body");

const sources = [{ url: "https://example.com/a", title: "A page" }];

const card = (details: unknown): string => {
	const result: ToolResultLike = { content: [{ type: "text", text: "The answer." }], details };
	return renderToStaticMarkup(<Body name="web_search" args={{ query: "omp" }} result={result} />);
};

/** The warning lines of a card, in order. */
function warnings(html: string): string[] {
	return [...html.matchAll(/<div class="tv-note tv-note--warn">([^<]*)<\/div>/g)].map(match => match[1] ?? "");
}

describe("web search card: the providers that failed before one answered", () => {
	test("one line per failed provider under the result, and none when no provider failed", () => {
		const response = { provider: "kagi", sources };
		const failed = card({
			response,
			failures: [
				{ provider: "brave", label: "Brave", reason: "HTTP 429 too many requests", status: 429 },
				{ provider: "exa", label: "Exa", reason: "no API key" },
			],
		});
		expect(warnings(failed)).toEqual(["Brave failed: HTTP 429 too many requests", "Exa failed: no API key"]);
		expect(failed.indexOf("The answer.")).toBeLessThan(failed.indexOf("Brave failed: HTTP 429"));

		expect(warnings(card({ response }))).toEqual([]);
		expect(warnings(card({ response, failures: [] }))).toEqual([]);
	});

	test("an entry without a text label or reason is skipped", () => {
		const html = card({
			response: { provider: "kagi", sources },
			failures: [
				{ provider: "brave", label: "Brave" },
				{ provider: "exa", reason: "no API key" },
				{ label: 3, reason: "x" },
				"Exa failed",
				null,
				{ provider: "jina", label: "Jina", reason: "timed out" },
			],
		});
		expect(warnings(html)).toEqual(["Jina failed: timed out"]);
	});
});
