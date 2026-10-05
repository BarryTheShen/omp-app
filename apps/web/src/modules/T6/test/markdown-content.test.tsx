import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { MarkdownContent } from "../../U1/markdown";

afterEach(cleanup);

describe("MarkdownContent", () => {
  test("renders compact headings, code and safe links through U1.4", () => {
    render(
      <MarkdownContent
        text={
          '# Answer\n\nHere is **bold** and `code`.\n\n[docs](https://example.test/docs)\n\n<script>alert("x")</script>'
        }
        variant="compact"
      />,
    );

    const heading = screen.getByRole("heading", { name: "Answer" });
    expect(heading.className).toContain("text-base");
    expect(document.querySelector("[data-markdown-inline]")).toBeTruthy();
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe(
      "https://example.test/docs",
    );
    expect(document.querySelector("script")).toBeNull();
  });
});
