import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { AstEditCard } from "./ast-edit";

afterEach(cleanup);

function props(
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  const args = {
    ops: [{ pat: "console.log($A)", out: "logger.info($A)" }],
    paths: ["src"],
  };
  return {
    type: "tool-call",
    toolCallId: "ast-edit-1",
    toolName: "ast_edit",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

describe("AstEditCard", () => {
  test("renders structural pattern, per-file counts and omp's formatted preview", () => {
    const displayContent = "-10│console.log(value)\n+10│logger.info(value)";
    render(
      <AstEditCard
        rendererProps={props({
          totalReplacements: 2,
          filesTouched: 1,
          filesSearched: 4,
          applied: false,
          fileReplacements: [{ path: "src/log.ts", count: 2 }],
          displayContent,
        })}
      />,
    );
    expandToolCards();
    expect(screen.getByTestId("t1-ast-edit-pattern").textContent).toContain("console.log($A)");
    expect(screen.getByRole("button", { name: "ast_edit: Complete" }).textContent).toContain(
      "2 replacements",
    );
    expect(screen.getByText("src/log.ts")).toBeTruthy();
    expect(screen.getByText("2 replacements")).toBeTruthy();
    expect(screen.getByTestId("t1-ast-edit-preview").textContent).toBe(displayContent);
    expect(screen.queryByText("(no before text)")).toBeNull();
    expect(screen.queryByText("(no replacement text)")).toBeNull();
  });

  test("shows parse errors and safety-limit guidance without claiming application", () => {
    render(
      <AstEditCard
        rendererProps={props({
          totalReplacements: 0,
          filesTouched: 0,
          limitReached: true,
          parseErrors: ["src/bad.ts: parse error (syntax tree contains error nodes)"],
        })}
      />,
    );
    expandToolCards();
    expect(screen.getByRole("alert").textContent).toContain("Parse errors");
    expect(screen.getByTestId("t1-ast-edit-limit").textContent).toContain("safety limit");
    expect(
      within(screen.getByRole("alert")).getByText(/syntax tree contains error nodes/),
    ).toBeTruthy();
  });

  test("keeps running structural context visible before a result exists", () => {
    render(<AstEditCard rendererProps={props(undefined, { type: "running" })} />);
    expandToolCards();
    expect(screen.getByTestId("t1-ast-edit-pattern")).toBeTruthy();
    expect(screen.getByRole("button", { name: "ast_edit: Running" })).toBeTruthy();
  });
});
