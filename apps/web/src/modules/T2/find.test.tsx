import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { FindCard } from "./find";

afterEach(cleanup);

/** Everything in a card's Raw details disclosure: where a finished call's raw JSON is kept. */
const RAW_DETAILS_CONTENT = "[data-slot='u3-tool-card-raw'] *";

function props(
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  const args = { query: "retry budget", grep_keywords: ["retry", "budget"], path: "src" };
  return {
    type: "tool-call",
    toolCallId: "find-1",
    toolName: "find",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function hit(index: number) {
  return {
    rel: `src/retry-${index}.ts`,
    nameScore: 0.5,
    contentScore: 0.8,
    linesSeen: 40,
    truncated: false,
    ranges: [{ start: 1, end: 5, p: 0.7, snippet: "retry()" }],
  };
}

describe("FindCard", () => {
  test("renders hits with verified ranges, probabilities, snippets and stats from result.details", () => {
    render(
      <FindCard
        rendererProps={props({
          content: [{ type: "text", text: "1 hit" }],
          details: {
            query: "retry budget",
            keywords: ["retry", "budget"],
            threshold: 0.2,
            cwd: "/repo",
            elapsedMs: 1500,
            hits: [
              {
                rel: "src/retry.ts",
                nameScore: 0.8,
                contentScore: 0.9,
                linesSeen: 120,
                truncated: false,
                ranges: [
                  { start: 10, end: 20, p: 0.9, snippet: "function retryBudget() {" },
                  { start: 42, end: 42, p: 0.35 },
                ],
              },
            ],
            stats: { requests: 3, inputTokens: 1200, outputTokens: 0, apiMs: 900, failures: [] },
          },
        })}
      />,
    );
    expandToolCards();
    expect(screen.getByText("retry budget in src · 1 hit")).toBeTruthy();
    expect(screen.getByText("src/retry.ts")).toBeTruthy();
    expect(screen.getByText("lines 10–20")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("function retryBudget() {")).toBeTruthy();
    expect(screen.getByText("line 42")).toBeTruthy();
    expect(screen.getByText("35%")).toBeTruthy();
    expect(screen.getByTestId("t2-find-stats").textContent).toBe(
      "3 requests · 1,200 input tokens · 1.5 s",
    );
    expect(screen.queryByText("No matches.")).toBeNull();
  });

  test("shows at most 20 hit rows and says how many were cut", () => {
    const hits = Array.from({ length: 27 }, (_, index) => hit(index + 1));
    render(<FindCard rendererProps={props({ hits, stats: { apiMs: 2340 } })} />);
    expandToolCards();
    expect(screen.getByText("retry budget in src · 27 hits")).toBeTruthy();
    expect(screen.getByText("src/retry-20.ts")).toBeTruthy();
    expect(screen.queryByText("src/retry-21.ts")).toBeNull();
    expect(screen.getByText("Showing 20 of 27")).toBeTruthy();
    expect(screen.getByTestId("t2-find-stats").textContent).toBe("2.3 s");
  });

  test("states that nothing matched without a hit count", () => {
    render(<FindCard rendererProps={props({ hits: [], stats: { requests: 1 } })} />);
    expandToolCards();
    expect(screen.getByText("No matches.")).toBeTruthy();
    expect(screen.getByText("retry budget in src")).toBeTruthy();
    expect(screen.queryByTestId("t2-find-hits")).toBeNull();
    expect(screen.getByTestId("t2-find-stats").textContent).toBe("1 request");
  });

  test("lists at most three request failures and counts the rest", () => {
    const failures = [
      "verification: timeout",
      "map: rate limited",
      "judge: bad response",
      "verification: boom",
      "map: boom",
    ];
    render(<FindCard rendererProps={props({ hits: [hit(1)], stats: { failures } })} />);
    expandToolCards();
    const lines = screen.getAllByTestId("t2-find-failure").map((line) => line.textContent);
    expect(lines).toEqual(failures.slice(0, 3));
    expect(screen.getByText("+2 more")).toBeTruthy();
  });

  test("shows one muted line for malformed details and keeps raw JSON out of the view", () => {
    render(<FindCard rendererProps={props({ content: [], details: { hits: "not a list" } })} />);
    expandToolCards();
    expect(screen.getByText("Search details unavailable.")).toBeTruthy();
    expect(screen.queryByText("No matches.")).toBeNull();
    expect(screen.queryByText(/not a list/, { ignore: RAW_DETAILS_CONTENT })).toBeNull();
  });

  test("a result with content but no details is unavailable, not empty", () => {
    render(<FindCard rendererProps={props({ content: [{ type: "text", text: "2 hits" }] })} />);
    expandToolCards();
    expect(screen.getByText("Search details unavailable.")).toBeTruthy();
    expect(screen.queryByText("No matches.")).toBeNull();
  });

  test("running state shows the query and scope from the arguments only", () => {
    render(<FindCard rendererProps={props(undefined, { type: "running" })} />);
    expandToolCards();
    expect(screen.getByText("retry budget in src")).toBeTruthy();
    expect(screen.getByTestId("tool-card-find-1").getAttribute("data-phase")).toBe("running");
    expect(screen.queryByText("No matches.")).toBeNull();
    expect(screen.queryByText("Search details unavailable.")).toBeNull();
    expect(screen.getByTestId("tool-card-find-1").className).toContain(
      "data-slot='u3-tool-card-args",
    );
  });
});
