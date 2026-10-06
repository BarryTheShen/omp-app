import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { AstGrepCard } from "./ast-grep";

afterEach(cleanup);

function props(
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  const args = { pat: "console.log($$$)", path: "src" };
  return {
    type: "tool-call",
    toolCallId: "ast-1",
    toolName: "ast_grep",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function envelope(details: unknown) {
  return { content: [{ type: "text", text: "matches" }], details };
}

describe("AstGrepCard", () => {
  test("groups omp's display rows by file with one line and snippet per match", () => {
    render(
      <AstGrepCard
        rendererProps={props(
          envelope({
            matchCount: 3,
            fileCount: 2,
            filesSearched: 14,
            limitReached: false,
            scopePath: "src",
            files: ["src/app.ts", "src/lib/log.ts"],
            fileMatches: [
              { path: "src/app.ts", count: 2 },
              { path: "src/lib/log.ts", count: 1 },
            ],
            displayContent: [
              "# src/",
              "## app.ts#3f2a",
              " *4│console.log(user)",
              " *9│console.log(",
              " 10│  total,",
              " 11│)",
              "## lib/",
              "### log.ts",
              " *2│console.log(message)",
              "  meta: $$$=message",
            ].join("\n"),
          }),
        )}
      />,
    );
    expect(screen.getByText("console.log($$$) in src · 3 matches")).toBeTruthy();
    expect(screen.getByText("src/app.ts")).toBeTruthy();
    expect(screen.getByText("src/lib/log.ts")).toBeTruthy();
    expect(screen.getByText("line 4")).toBeTruthy();
    expect(screen.getByText("console.log(user)")).toBeTruthy();
    expect(screen.getByText("line 9")).toBeTruthy();
    expect(screen.queryByText("line 10")).toBeNull();
    expect(screen.getByText("console.log(message)")).toBeTruthy();
    expect(screen.getByTestId("t2-ast-grep-stats").textContent).toBe(
      "3 matches in 2 files · 14 files searched",
    );
  });

  test("cuts the match list at 20 rows and notes the match limit", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ` *${index + 1}│log(${index + 1})`);
    render(
      <AstGrepCard
        rendererProps={props(
          envelope({
            matchCount: 50,
            fileCount: 1,
            limitReached: true,
            displayContent: ["# src/big.ts", ...rows].join("\n"),
          }),
        )}
      />,
    );
    expect(screen.getByText("line 20")).toBeTruthy();
    expect(screen.queryByText("line 21")).toBeNull();
    expect(screen.getByText("Showing 20 of 50")).toBeTruthy();
    expect(screen.getByTestId("t2-ast-grep-limit")).toBeTruthy();
  });

  test("shows at most three parse errors and counts the rest", () => {
    const parseErrors = ["a.ts: parse error", "b.ts: parse error", "c.ts: parse error"];
    render(
      <AstGrepCard
        rendererProps={props(
          envelope({ matchCount: 0, fileCount: 0, parseErrors, parseErrorsTotal: 7 }),
        )}
      />,
    );
    const lines = screen.getAllByTestId("t2-ast-grep-parse-error").map((line) => line.textContent);
    expect(lines).toEqual(parseErrors);
    expect(screen.getByText("+4 more")).toBeTruthy();
    expect(screen.getByText("No matches.")).toBeTruthy();
  });

  test("states that nothing matched without a match count", () => {
    render(
      <AstGrepCard
        rendererProps={props(envelope({ matchCount: 0, fileCount: 0, filesSearched: 9 }))}
      />,
    );
    expect(screen.getByText("No matches.")).toBeTruthy();
    expect(screen.getByText("console.log($$$) in src")).toBeTruthy();
    expect(screen.getByTestId("t2-ast-grep-stats").textContent).toBe("9 files searched");
  });

  test("shows one muted line for malformed details and keeps raw JSON out of the view", () => {
    render(<AstGrepCard rendererProps={props(envelope({ files: [{ path: "src/a.ts" }] }))} />);
    expect(screen.getByText("Search details unavailable.")).toBeTruthy();
    expect(screen.queryByText("No matches.")).toBeNull();
    expect(screen.queryByText(/"path"/)).toBeNull();
  });

  test("running state shows the pattern and scope from the arguments only", () => {
    render(<AstGrepCard rendererProps={props(undefined, { type: "running" })} />);
    expect(screen.getByText("console.log($$$) in src")).toBeTruthy();
    expect(screen.getByTestId("tool-card-ast-1").getAttribute("data-phase")).toBe("running");
    expect(screen.queryByText("No matches.")).toBeNull();
    expect(screen.queryByText("Search details unavailable.")).toBeNull();
  });
});
