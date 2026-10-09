import type { ThemedToken } from "shiki/core";
import { describe, expect, test, vi } from "vitest";
import {
  getHighlighter,
  loadLanguage,
  THEME_NAME,
  type Tokenized,
  tokenizeLines,
  tokenizeNow,
} from "../../markdown/code-highlight";

/** Each token as what is drawn: its text, colour and font style (the offsets differ between the two paths). */
function drawn(rows: readonly (readonly ThemedToken[])[]): unknown[] {
  return rows.map((row) => row.map((token) => [token.content, token.color, token.fontStyle]));
}

async function typescriptHighlighter() {
  await loadLanguage("typescript");
  return getHighlighter();
}

const COMMENTED = [
  "export function sum(values: number[]): number {",
  "  /* a comment that",
  "     spans lines */",
  "  let total = 0;",
  "  return total; // done",
  "}",
];

describe("tokenizeLines", () => {
  test("a block grown one line at a time is drawn exactly as a full tokenization of it", async () => {
    const shiki = await typescriptHighlighter();
    let base: Tokenized | null = null;

    for (let count = 1; count <= COMMENTED.length; count += 1) {
      const lines = COMMENTED.slice(0, count);
      base = tokenizeLines(shiki, "typescript", lines, base);
      const full = shiki.codeToTokens(lines.join("\n"), {
        lang: "typescript",
        theme: THEME_NAME,
      }).tokens;
      expect(drawn(base.tokens)).toEqual(drawn(full));
    }
  });

  test("an edit that opens a comment recolours the lines after it, as a full tokenization does", async () => {
    const shiki = await typescriptHighlighter();
    const before = ["const a = 1;", "/* closed */", "const b = 2;", "const c = 3;"];
    const after = ["const a = 1;", "/* open", "const b = 2;", "const c = 3;"];

    const first = tokenizeLines(shiki, "typescript", before, null);
    const second = tokenizeLines(shiki, "typescript", after, first);

    const full = shiki.codeToTokens(after.join("\n"), { lang: "typescript", theme: THEME_NAME });
    expect(drawn(second.tokens)).toEqual(drawn(full.tokens));
  });

  test("appending a line tokenizes only that line", async () => {
    const shiki = await typescriptHighlighter();
    const lines = Array.from({ length: 300 }, (_, index) => `const value${index} = ${index};`);
    const base = tokenizeLines(shiki, "typescript", lines, null);
    const spy = vi.spyOn(shiki, "codeToTokensBase");

    const grown = tokenizeLines(shiki, "typescript", [...lines, "const last = 1;"], base);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(grown.tokens).toHaveLength(lines.length + 1);
    spy.mockRestore();
  });

  test("a text that did not change returns the tokenization it has", async () => {
    const shiki = await typescriptHighlighter();
    const lines = ["const a = 1;"];
    const base = tokenizeLines(shiki, "typescript", lines, null);

    expect(tokenizeLines(shiki, "typescript", [...lines], base)).toBe(base);
  });
});

describe("tokenizeNow", () => {
  test("colours a small change at once, leaves a large one to the background, and waits for the language", async () => {
    await typescriptHighlighter();
    const base = tokenizeNow(null, "typescript", ["const a = 1;"]);
    expect(base).toBeDefined();

    expect(tokenizeNow(base ?? null, "typescript", ["const a = 1;", "const b = 2;"])).toBeDefined();
    const large = ["const a = 1;", ...Array.from({ length: 200 }, () => "const value = 2;")];
    expect(tokenizeNow(base ?? null, "typescript", large)).toBeUndefined();
    // Python is not loaded in this file, so nothing is coloured in a render.
    expect(tokenizeNow(null, "python", ["value = 1"])).toBeUndefined();
  });
});
