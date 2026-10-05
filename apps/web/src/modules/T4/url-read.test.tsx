import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { T4ReadUrlRenderer } from "./url-read";

afterEach(() => cleanup());

function props(result: unknown): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "url-read-1",
    toolName: "read",
    args: { path: "https://example.test/docs" },
    argsText: '{"path":"https://example.test/docs"}',
    result,
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

describe("T4ReadUrlRenderer", () => {
  test("renders redirects, untrusted Markdown, sources, screenshots and truncation", () => {
    render(
      T4ReadUrlRenderer({
        toolCallId: "url-read-1" as never,
        rendererProps: props({
          kind: "url",
          url: "https://example.test/docs",
          finalUrl: "https://example.test/docs/final",
          displayContent: { text: "# Retrieved page\n\n[external](https://source.test/page)" },
          contentType: "text/markdown",
          method: "GET",
          totalLines: 2,
          truncation: { direction: "tail", reason: "lines", omittedLines: 4 },
          notes: ["Retrieved from the network"],
          sources: [{ title: "Source", url: "https://source.test/page", snippet: "Snippet" }],
          screenshots: [{ data: "data:image/png;base64,AAAA" }],
        }),
        details: {
          kind: "url",
          url: "https://example.test/docs",
          finalUrl: "https://example.test/docs/final",
          displayContent: { text: "# Retrieved page\n\n[external](https://source.test/page)" },
          contentType: "text/markdown",
          method: "GET",
          totalLines: 2,
          truncation: { direction: "tail", reason: "lines", omittedLines: 4 },
          notes: ["Retrieved from the network"],
          sources: [{ title: "Source", url: "https://source.test/page", snippet: "Snippet" }],
          screenshots: [{ data: "data:image/png;base64,AAAA" }],
        } as never,
        rawArgs: '{"path":"https://example.test/docs"}',
        rawResult: "raw page",
      }),
    );
    expect(screen.getByTestId("t4-url-read")).toBeTruthy();
    expect(screen.getByText("example.test/docs → example.test/docs/final")).toBeTruthy();
    expect(screen.getByText("Retrieved page")).toBeTruthy();
    expect(screen.getByText("Notes:")).toBeTruthy();
    expect(screen.getByText("Output shortened; omitted 4 lines")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Browser screenshot 1" })).toBeTruthy();
    const links = screen.getAllByRole("link");
    expect(links.some((link) => link.getAttribute("href") === "https://source.test/page")).toBe(
      true,
    );
    expect(
      links.every(
        (link) =>
          link.getAttribute("target") === "_blank" &&
          link.getAttribute("rel") === "noopener noreferrer",
      ),
    ).toBe(true);
  });

  test("renders internal catalog metadata without turning internal URLs into external links", () => {
    render(
      T4ReadUrlRenderer({
        toolCallId: "url-read-1" as never,
        rendererProps: props({ kind: "url", url: "skill://review" }),
        details: {
          kind: "url",
          url: "skill://review",
          catalog: { scheme: "skill", name: "review", title: "Review skill" },
          displayContent: { text: "# Skill content" },
        } as never,
        rawArgs: "skill://review",
        rawResult: "skill content",
      }),
    );
    expect(screen.getByText("Resource metadata")).toBeTruthy();
    expect(screen.getByText("Skill content")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /skill/i })).toBeNull();
  });
});
