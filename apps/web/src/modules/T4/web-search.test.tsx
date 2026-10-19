import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { T4_SCRIPTED_SEARCH_RESULTS } from "./fixtures/real-results";
import { SEARCH_RESULT } from "./fixtures/v18.9.1-results";
import { WebSearchCard } from "./web-search";

afterEach(() => cleanup());

function props(
  result: unknown,
  args: unknown = { query: "omp app" },
  status: ToolRendererProps["status"] = { type: "complete" },
  isError = false,
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "web-search-1",
    toolName: "web_search",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
    isError,
  } as unknown as ToolRendererProps;
}

function scriptedSearchResult(name: string): unknown {
  const item = T4_SCRIPTED_SEARCH_RESULTS.find((entry) => entry.name === name);
  if (!item) throw new Error(`Missing scripted search result: ${name}`);
  return item.result;
}

describe("WebSearchCard", () => {
  test("renders source-shaped provider, auth and total-token labels", () => {
    render(<WebSearchCard rendererProps={props(SEARCH_RESULT)} />);
    expandToolCards();

    expect(screen.getByText("Provider: Perplexity")).toBeTruthy();
    expect(screen.getByText("Auth: API")).toBeTruthy();
    expect(screen.getByText("Total tokens: 560")).toBeTruthy();
    expect(screen.getByText("Search requests: 2")).toBeTruthy();
    expect(screen.queryByText("perplexity")).toBeNull();
    expect(screen.queryByText(/Cost:/)).toBeNull();
  });

  test("uses the host label when a scripted source has a blank title", () => {
    render(
      <WebSearchCard
        rendererProps={props(scriptedSearchResult("web_search: an answer with sources"))}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("link", { name: "www.example.test" }).getAttribute("href")).toBe(
      "https://www.example.test/docs/syllabus.pdf",
    );
    expect(screen.getByText("Exa")).toBeTruthy();
    expect(screen.queryByText("exa")).toBeNull();
  });

  test("shows zero-source warnings and readable anonymous auth from a recording", () => {
    render(
      <WebSearchCard
        rendererProps={props(
          scriptedSearchResult("web_search: the answer omp's anonymous search gives (no sources)"),
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByText("No sources were returned for this search.")).toBeTruthy();
    expect(screen.getByText("Provider: Perplexity")).toBeTruthy();
    expect(screen.getByText("Auth: Anonymous")).toBeTruthy();
  });

  test("shows an interrupted search with raw output when omp supplies no details", () => {
    const { container } = render(
      <WebSearchCard
        rendererProps={props(
          scriptedSearchResult("web_search: an interrupted call with no details"),
          { query: "interrupted search" },
          { type: "complete" },
          true,
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("button", { name: "web_search: Error" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Tool execution was aborted");
    expect(container.querySelector('[data-slot="t4-web-search-body"]')).toBeNull();
  });

  test("keeps raw streaming output visible before structured details arrive", () => {
    render(
      <WebSearchCard
        rendererProps={props("answer fragment", { query: "streaming" }, { type: "running" })}
      />,
    );
    expandToolCards();
    expect(screen.getByRole("button", { name: "web_search: Running" })).toBeTruthy();
    expect(screen.getByText("answer fragment")).toBeTruthy();
  });

  test("maps malformed settled results to an error while retaining raw output", () => {
    render(<WebSearchCard rendererProps={props("not-an-object")} />);
    expandToolCards();
    expect(screen.getByRole("button", { name: "web_search: Error" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Malformed web-search result");
    expect(screen.getByText("not-an-object")).toBeTruthy();
  });

  test("copies the source-shaped answer through the explicit callback", async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    render(<WebSearchCard onCopy={onCopy} rendererProps={props(SEARCH_RESULT)} />);
    expandToolCards();
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() =>
      expect(onCopy).toHaveBeenCalledWith(SEARCH_RESULT.details.response.answer, "code"),
    );
  });
});
