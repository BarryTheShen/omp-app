import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { WebSearchCard } from "./web-search";

afterEach(() => cleanup());

function props(
  result: unknown,
  args: unknown = { query: "omp app" },
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "web-search-1",
    toolName: "web_search",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

const successResult = {
  kind: "web_search",
  query: "omp app",
  response: {
    provider: "test-provider",
    model: "test-model",
    answer: "# Answer\n\nUse [the safe source](https://example.com/docs).",
    sources: [
      {
        title: "Safe source",
        url: "https://example.com/docs",
        domain: "example.com",
        snippet: "A retrieval-provided snippet.",
        author: "Ada",
      },
      { title: "Unsafe source", url: "javascript:alert(1)" },
    ],
    citations: [
      { title: "Safe source", url: "https://example.com/docs", citedText: "the cited text" },
    ],
    relatedQuestions: ["What is omp?"],
    usage: { inputTokens: 12, outputTokens: 34, searchRequests: 1 },
    authMode: "managed",
  },
};

describe("WebSearchCard", () => {
  test("renders query, compact Markdown, source tree, citations and usage metadata", () => {
    render(<WebSearchCard rendererProps={props(successResult)} />);

    expect(screen.getByRole("button", { name: "web_search: Complete" })).toBeTruthy();
    expect(screen.getAllByText("omp app").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Answer" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "the safe source" }).getAttribute("rel")).toContain(
      "noopener",
    );
    expect(screen.getAllByRole("link", { name: "Safe source" })[0]?.getAttribute("href")).toBe(
      "https://example.com/docs",
    );
    expect(screen.getByText("Unsafe source")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Unsafe source" })).toBeNull();
    expect(screen.getByText("[1]")).toBeTruthy();
    expect(screen.getByText("Provider: test-provider")).toBeTruthy();
    expect(screen.getAllByText("2 results").length).toBeGreaterThan(0);
    expect(screen.getByText("Search requests: 1")).toBeTruthy();
    expect(screen.queryByText(/"response"/)).toBeNull();
  });

  test("shows an explicit zero-source warning", () => {
    render(
      <WebSearchCard
        rendererProps={props({
          kind: "web_search",
          query: "nothing",
          response: { provider: "test-provider", answer: "No results.", sources: [] },
        })}
      />,
    );

    expect(screen.getByText("No sources were returned for this search.")).toBeTruthy();
    expect(screen.getAllByText("0 results").length).toBeGreaterThan(0);
  });

  test("surfaces a provider failure in a typed error state", () => {
    render(
      <WebSearchCard
        rendererProps={props({
          kind: "web_search",
          query: "blocked",
          response: { provider: "test-provider", sources: [] },
          error: "Provider rejected the request",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "web_search: Error" })).toBeTruthy();
    expect(screen.getAllByText("Provider rejected the request").length).toBeGreaterThan(0);
  });

  test("keeps streaming raw output visible until structured details arrive", () => {
    render(
      <WebSearchCard
        rendererProps={props("answer fragment", { query: "streaming" }, { type: "running" })}
      />,
    );

    expect(screen.getByRole("button", { name: "web_search: Running" })).toBeTruthy();
    expect(screen.getByText("answer fragment")).toBeTruthy();
  });

  test("maps malformed settled results to an open error while retaining raw output", () => {
    render(<WebSearchCard rendererProps={props("not-an-object")} />);

    expect(screen.getByRole("button", { name: "web_search: Error" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Malformed web-search result");
    expect(screen.getByText("not-an-object")).toBeTruthy();
  });

  test("copies the answer through the explicit callback", async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    render(<WebSearchCard onCopy={onCopy} rendererProps={props(successResult)} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() =>
      expect(onCopy).toHaveBeenCalledWith(
        "# Answer\n\nUse [the safe source](https://example.com/docs).",
        "code",
      ),
    );
  });
});
