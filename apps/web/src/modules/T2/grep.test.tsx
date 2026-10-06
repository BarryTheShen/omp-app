import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { GrepCard } from "./grep";

function props(result: unknown): ToolRendererProps {
  return {
    toolCallId: "grep-1" as never,
    toolName: "grep",
    args: { pattern: "TODO", path: "src", case: true, gitignore: true },
    argsText: '{"pattern":"TODO"}',
    result,
    status: { type: "complete", reason: "stop" },
  } as unknown as ToolRendererProps;
}

afterEach(cleanup);

describe("T2 GrepCard", () => {
  test("groups matches by file, links safe targets and shows flags/limits", () => {
    render(
      <GrepCard
        {...props({
          content: [{ type: "text", text: "raw grep" }],
          details: {
            matchCount: 3,
            fileCount: 1,
            meta: { total: 47 },
            fileMatches: [
              {
                path: "src/main.ts",
                count: 2,
                matches: [
                  { line: 4, snippet: "TODO first" },
                  { line: 8, snippet: "TODO second" },
                ],
                snippets: [{ line: 3, snippet: "before context" }],
              },
            ],
            truncated: true,
            fileLimitReached: true,
          },
        })}
      />,
    );
    expect(screen.getByLabelText("Grep matches by file")).toBeTruthy();
    expect(screen.getByRole("link", { name: "src/main.ts" }).getAttribute("href")).toBe(
      "src/main.ts",
    );
    expect(screen.getByText("case-sensitive")).toBeTruthy();
    expect(screen.getByText("gitignore")).toBeTruthy();
    expect(screen.getByText("TODO in src · 47 matches")).toBeTruthy();
    expect(document.querySelectorAll("[data-t2-grep-match-row]")).toHaveLength(2);
    expect(document.querySelectorAll("[data-t2-grep-context-row]")).toHaveLength(1);
    expect(
      [...document.querySelectorAll("[data-t2-grep-line]")].map((row) =>
        row.getAttribute("data-t2-grep-line"),
      ),
    ).toEqual(["3", "4", "8"]);
    expect(document.querySelectorAll("mark")).toHaveLength(2);
    expect(screen.getByText("Showing 3 of 47 matches")).toBeTruthy();
  });

  test("shows no matches explicitly and malformed details remain visible", () => {
    render(<GrepCard {...props({ content: [], details: { matchCount: 0 } })} />);
    expect(screen.getByText("No matches found.")).toBeTruthy();
    cleanup();
    render(<GrepCard {...props({ content: "raw", details: "malformed" })} />);
    expect(screen.getByTestId("tool-card-grep-1")).toBeTruthy();
  });
});
