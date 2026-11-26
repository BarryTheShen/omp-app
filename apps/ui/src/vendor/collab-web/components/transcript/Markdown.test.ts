import { describe, expect, test } from "vitest";
import { headingIndex, headingSlug, renderStreamingMarkdown } from "./Markdown";

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

describe("links to a heading of the same text", () => {
  test("headings carry GitHub's anchors, in any script", () => {
    expect(headingSlug("For AI agents")).toBe("for-ai-agents");
    expect(headingSlug("中文")).toBe("中文");
    expect(headingSlug("johnny: your server, and how to reach it with Tailscale")).toBe(
      "johnny-your-server-and-how-to-reach-it-with-tailscale",
    );
    expect(headingSlug("Step 2 — `ssh` in")).toBe("step-2--ssh-in");
    expect(render("## For **AI** agents")).toContain('<h2 data-heading="for-ai-agents">');
  });

  test("a #section link stays in the page, never a new tab", () => {
    const html = render("[中文](#中文) · [For AI agents](#for-ai-agents)");
    expect(html).toContain('<a href="#for-ai-agents" data-anchor="for-ai-agents">For AI agents</a>');
    expect(html).toContain('data-anchor="中文"');
    expect(html).not.toContain('target="_blank"');
  });

  test("the link finds its heading, repeated headings numbered as GitHub numbers them", () => {
    const html = render("# Notes\n\none\n\n# Notes\n\ntwo\n\n## 中文\n\nthree");
    const slugs = [...html.matchAll(/data-heading="([^"]*)"/g)].map((match) => match[1] ?? "");
    expect(slugs).toEqual(["notes", "notes", "中文"]);
    expect(headingIndex(slugs, "notes")).toBe(0);
    expect(headingIndex(slugs, "notes-1")).toBe(1);
    // A browser sends the fragment percent-encoded.
    expect(headingIndex(slugs, encodeURIComponent("中文"))).toBe(2);
    expect(headingIndex(slugs, "missing")).toBe(-1);
  });
});
