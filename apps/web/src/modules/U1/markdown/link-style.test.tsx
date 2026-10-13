import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MarkdownContent } from "./markdown-content";

afterEach(() => cleanup());

describe("a link in a reply looks like a link (issue 1304)", () => {
  test.each([
    ["a named link", "A [link to example](https://example.com/page) here."],
    [
      "a disguised link, which keeps its address",
      "Check [example.com](https://evil.test/login) first.",
    ],
    ["a bare URL", "A bare https://example.org link."],
  ])("%s has the primary colour, an underline and a darker hover", async (_name, markdown) => {
    render(<MarkdownContent text={markdown} />);
    const link = await screen.findByRole("link");
    expect(link.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["text-primary", "underline", "hover:text-primary/80"]),
    );
  });

  test("a link in a compact block, such as a note or a summary, looks like a link too", async () => {
    render(<MarkdownContent text="See [the page](https://example.com/page)." variant="compact" />);
    const link = await screen.findByRole("link", { name: "the page" });
    expect(link.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["text-primary", "underline"]),
    );
  });
});
