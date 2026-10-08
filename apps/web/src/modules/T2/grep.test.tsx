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
  test("names the match count and shows the matched lines omp displayed", () => {
    render(
      <GrepCard
        {...props({
          content: [{ type: "text", text: "raw grep" }],
          details: {
            matchCount: 3,
            fileCount: 1,
            files: ["src/main.ts"],
            fileMatches: [{ path: "src/main.ts", count: 3 }],
            displayContent: "# src/\n## main.ts\n*4│TODO first\n*8│TODO second\n 3│before context",
            truncated: false,
          },
        })}
      />,
    );
    expect(screen.getByText("TODO in src · 3 matches")).toBeTruthy();
    expect(screen.getByLabelText("Grep matches by file")).toBeTruthy();
    expect(screen.getByText("(3 matches)")).toBeTruthy();
    const lines = document.querySelector("[data-t2-grep-lines]")?.textContent ?? "";
    expect(lines).toContain("TODO first");
    expect(lines).toContain("TODO second");
  });

  test("shows no matches explicitly and malformed details remain visible", () => {
    render(<GrepCard {...props({ content: [], details: { matchCount: 0 } })} />);
    expect(screen.getByText("No matches found.")).toBeTruthy();
    cleanup();
    render(<GrepCard {...props({ content: "raw", details: "malformed" })} />);
    expect(screen.getByTestId("tool-card-grep-1")).toBeTruthy();
  });
});
