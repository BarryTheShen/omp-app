import { describe, expect, test } from "vitest";
import { previewDocument } from "./htmlPreview";

describe("the HTML preview's document", () => {
  test("a page's doctype stays first, so it keeps its rendering mode; the base comes right after it", () => {
    expect(
      previewDocument('  <!DOCTYPE html>\n<link rel="stylesheet" href="site.css"><h1>A</h1>'),
    ).toBe(
      '  <!DOCTYPE html><base href="about:srcdoc">\n<link rel="stylesheet" href="site.css"><h1>A</h1>',
    );
  });

  test("a page without a doctype gets the base first, before its own base", () => {
    expect(previewDocument('<base href="https://example.com/"><img src="a.png">')).toBe(
      '<base href="about:srcdoc"><base href="https://example.com/"><img src="a.png">',
    );
  });
});
