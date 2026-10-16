import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { AstEditCard } from "./ast-edit";

// omp v18.8.9 emits file counts and displayContent in packages/coding-agent/src/tools/ast-edit.ts:422,536-541;
// packages/tui/src/render/render-utils.ts:429-440 defines the line-number gutter used in displayContent.
// The sample text is hand-written in that shape; the test exercises the card, not a copy of omp's formatter.
const modelText =
  "-10:3 legacyCall(a0)\n+10:3 modernCall(a0)\n-14:3 legacyCall(a1)\n+14:3 modernCall(a1)\n\n-2:5 legacyCall(b0)\n+2:5 modernCall(b0)";
const displayContent =
  "-10│legacyCall(a0)\n+10│modernCall(a0)\n-14│legacyCall(a1)\n+14│modernCall(a1)\n\n-2│legacyCall(b0)\n+2│modernCall(b0)";

afterEach(() => cleanup());

describe("AST-edit preview", () => {
  test("shows omp's per-file counts and formatted lines without fabricating replacement text", () => {
    const args = {
      ops: [{ pat: "legacyCall($A)", out: "modernCall($A)" }],
      paths: ["src/app.ts", "src/view.ts"],
    };
    const rendererProps = {
      type: "tool-call",
      toolCallId: "ast-edit-preview-counts",
      toolName: "ast_edit",
      args,
      argsText: JSON.stringify(args),
      result: {
        content: [{ type: "text", text: modelText }],
        details: {
          totalReplacements: 3,
          filesTouched: 2,
          filesSearched: 4,
          applied: false,
          fileReplacements: [
            { path: "src/app.ts", count: 2 },
            { path: "src/view.ts", count: 1 },
          ],
          displayContent,
        },
      },
      status: { type: "complete" },
    } as unknown as ToolRendererProps;

    render(<AstEditCard rendererProps={rendererProps} />);
    expandToolCards();

    expect(screen.getByRole("button", { name: "ast_edit: Complete" }).textContent).toContain(
      "3 replacements · 2 files",
    );
    const files = screen.getByTestId("t1-ast-edit-replacements");
    expect(files.textContent).toContain("src/app.ts");
    expect(files.textContent).toContain("2 replacements");
    expect(files.textContent).toContain("src/view.ts");
    expect(files.textContent).toContain("1 replacement");
    expect(screen.getByTestId("t1-ast-edit-preview").textContent).toBe(displayContent);
    expect(screen.queryByText("(no before text)")).toBeNull();
    expect(screen.queryByText("(no replacement text)")).toBeNull();
  });
  test("shows per-file counts for omp's grouped preview too", () => {
    const groupedDisplayContent =
      "# src/\n## app.ts (2 replacements)\n-10│legacyCall(a0)\n+10│modernCall(a0)\n-14│legacyCall(a1)\n+14│modernCall(a1)";
    const args = {
      ops: [{ pat: "legacyCall($A)", out: "modernCall($A)" }],
      paths: ["src"],
    };
    const rendererProps = {
      type: "tool-call",
      toolCallId: "ast-edit-grouped-preview-counts",
      toolName: "ast_edit",
      args,
      argsText: JSON.stringify(args),
      result: {
        content: [{ type: "text", text: modelText }],
        details: {
          totalReplacements: 2,
          filesTouched: 1,
          filesSearched: 3,
          applied: false,
          fileReplacements: [{ path: "src/app.ts", count: 2 }],
          displayContent: groupedDisplayContent,
        },
      },
      status: { type: "complete" },
    } as unknown as ToolRendererProps;

    render(<AstEditCard rendererProps={rendererProps} />);
    expandToolCards();

    const files = screen.getByTestId("t1-ast-edit-replacements");
    expect(files.textContent).toContain("src/app.ts");
    expect(files.textContent).toContain("2 replacements");
    expect(screen.getByTestId("t1-ast-edit-preview").textContent).toBe(groupedDisplayContent);
  });
});
