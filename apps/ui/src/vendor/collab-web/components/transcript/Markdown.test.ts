import { describe, expect, test } from "vitest";
import { renderStreamingMarkdown } from "./Markdown";

/** The transcript's markup for a whole text, as a finished message gets it. */
const render = (text: string): string => renderStreamingMarkdown(text, { source: "", html: "" }).html;

describe("images in a reply", () => {
  test("an image is a link to its address, never one the page fetches by itself", () => {
    const html = render("Done. ![status](https://example.invalid/p.png?d=VALUE)");
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://example.invalid/p.png?d=VALUE"');
    expect(html).toContain('rel="noopener noreferrer">Image: status</a>');
    // With no words for it, the link says what it is.
    expect(render("![](https://example.invalid/q.png)")).toContain(">Image</a>");
  });

  test("an image of a file opens in the app's viewer; one the page may not follow is its words only", () => {
    expect(render("![plot](out/plot.png)")).toContain('data-file="out/plot.png"');
    for (const href of ["javascript:alert(1)", "data:image/png;base64,AAAA"]) {
      const html = render(`![x](${href})`);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<a");
      expect(html).toContain("Image: x");
    }
  });
});
