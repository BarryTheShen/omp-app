import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { LspCard } from "./lsp";

afterEach(cleanup);

function props(
  args: Record<string, unknown>,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: "lsp-1",
    toolName: "lsp",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

function answer(action: string, text: string, success = true) {
  return {
    content: [{ type: "text", text }],
    details: { serverName: "typescript-language-server", action, success },
  };
}

describe("LspCard", () => {
  test("renders hover text as compact Markdown", () => {
    const args = { action: "hover", file: "src/app.ts", line: 12, symbol: "retryBudget" };
    render(
      <LspCard
        rendererProps={props(
          args,
          answer("hover", "```typescript\nconst retryBudget: number\n```\nRetries left."),
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Hover · src/app.ts:12")).toBeTruthy();
    expect(screen.getByText("const retryBudget: number")).toBeTruthy();
    expect(screen.getByText("Retries left.")).toBeTruthy();
  });

  test("renders grouped diagnostics with severity chips, file:line and messages", () => {
    const text = [
      "1 error(s), 1 warning(s), 1 hint(s):",
      "# src/",
      "## app.ts",
      "  4:7 [error] [typescript] Cannot find name 'retry'. (2304)",
      "  9:1 [warning] Unused variable",
      "  12:3 [hint] Prefer const",
      "⚠ some servers failed: eslint",
    ].join("\n");
    render(
      <LspCard
        rendererProps={props(
          { action: "diagnostics", file: "src/app.ts" },
          answer("diagnostics", text),
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Diagnostics · src/app.ts")).toBeTruthy();
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("src/app.ts:4")).toBeTruthy();
    expect(screen.getByText("Cannot find name 'retry'. (2304)")).toBeTruthy();
    expect(screen.getByText("Warning")).toBeTruthy();
    expect(screen.getByText("Hint")).toBeTruthy();
    expect(screen.getByText("Partly failed")).toBeTruthy();
    expect(screen.getByText("some servers failed: eslint")).toBeTruthy();
  });

  test("a clean diagnostics run says there are no issues", () => {
    render(
      <LspCard
        rendererProps={props(
          { action: "diagnostics", file: "src/app.ts" },
          answer("diagnostics", "OK"),
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("No issues.")).toBeTruthy();
  });

  test("cuts references at 20 rows and says how many there are", () => {
    const locations = Array.from(
      { length: 26 },
      (_, index) => `  src/file-${index + 1}.ts:${index + 3}:5\n    ${index + 3}│retryBudget()`,
    );
    const text = `Found 26 reference(s):\n${locations.join("\n")}`;
    render(
      <LspCard
        rendererProps={props(
          { action: "references", file: "src/app.ts", line: 12, symbol: "retryBudget" },
          answer("references", text),
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("References to retryBudget")).toBeTruthy();
    expect(screen.getByText("src/file-1.ts:3")).toBeTruthy();
    expect(screen.getByText("src/file-20.ts:22")).toBeTruthy();
    expect(screen.queryByText("src/file-21.ts:23")).toBeNull();
    expect(screen.getByText("Showing 20 of 26")).toBeTruthy();
  });

  test("lists document symbols with their names", () => {
    const text =
      "Symbols in src/app.ts:\n* RetryPolicy @ line 3\n  - retryBudget(): number @ line 8";
    render(
      <LspCard
        rendererProps={props({ action: "symbols", file: "src/app.ts" }, answer("symbols", text))}
      />,
    );
    expandToolCards();
    expect(screen.getByText("src/app.ts:3")).toBeTruthy();
    expect(screen.getByText("RetryPolicy")).toBeTruthy();
    expect(screen.getByText("retryBudget(): number")).toBeTruthy();
  });

  test("shows renamed files with edit counts and whether the rename was applied", () => {
    const args = { action: "rename", file: "src/app.ts", line: 8, symbol: "foo", new_name: "bar" };
    render(
      <LspCard
        rendererProps={props(
          args,
          answer(
            "rename",
            "Applied rename:\n  Applied 3 edit(s) to src/app.ts\n  Applied 1 edit(s) to src/b.ts",
          ),
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Rename foo → bar")).toBeTruthy();
    expect(screen.getByTestId("t2-lsp-rename-status").textContent).toBe(
      "Applied to the files below.",
    );
    expect(screen.getByText("3 edits")).toBeTruthy();
    expect(screen.getByText("1 edit")).toBeTruthy();
    cleanup();
    render(
      <LspCard
        rendererProps={props(
          { ...args, apply: false },
          answer("rename", "Rename preview:\n  src/app.ts: 3 edits"),
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByTestId("t2-lsp-rename-status").textContent).toBe(
      "Preview only, not applied.",
    );
  });

  test("other actions show the text output, cut at 40 lines with a Show all button", () => {
    const text = Array.from({ length: 45 }, (_, index) => `capability ${index + 1}`).join("\n");
    render(
      <LspCard rendererProps={props({ action: "capabilities" }, answer("capabilities", text))} />,
    );
    expandToolCards();
    expect(screen.getByText("Capabilities")).toBeTruthy();
    expect(screen.getByTestId("t2-lsp-text").textContent).toContain("capability 40");
    expect(screen.getByTestId("t2-lsp-text").textContent).not.toContain("capability 41");
    fireEvent.click(screen.getByRole("button", { name: "Show all 45 lines" }));
    expect(screen.getByTestId("t2-lsp-text").textContent).toContain("capability 45");
  });

  test("a failed request becomes the card's error banner instead of a second status line", () => {
    render(
      <LspCard
        rendererProps={props(
          { action: "definition", file: "src/app.ts", line: 3 },
          answer("definition", "LSP error: server crashed", false),
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByTestId("tool-card-lsp-1").getAttribute("data-phase")).toBe("error");
    expect(screen.getByRole("alert").textContent).toContain("LSP error: server crashed");
    expect(screen.queryByTestId("t2-lsp-text")).toBeNull();
  });

  test("shows one muted line for a malformed result", () => {
    render(
      <LspCard rendererProps={props({ action: "hover", file: "src/app.ts" }, { content: "x" })} />,
    );
    expandToolCards();
    expect(screen.getByText("Language server details unavailable.")).toBeTruthy();
  });

  test("running state shows the action and target from the arguments only", () => {
    render(
      <LspCard
        rendererProps={props({ action: "hover", file: "src/app.ts", line: 12 }, undefined, {
          type: "running",
        })}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Hover · src/app.ts:12")).toBeTruthy();
    expect(screen.getByTestId("tool-card-lsp-1").getAttribute("data-phase")).toBe("running");
    expect(screen.queryByText("Language server details unavailable.")).toBeNull();
  });
});
