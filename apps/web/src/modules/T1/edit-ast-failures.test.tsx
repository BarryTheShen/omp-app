import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { AstEditCard } from "./ast-edit";
import { EditCard } from "./edit";

// omp v18.8.9 uses `input` for apply_patch (packages/coding-agent/src/edit/schemas.ts:33-35).
// A thrown tool error is emitted as text with empty details and the error flag (packages/agent/src/agent-loop.ts:3591-3598).
// A multi-file patch wraps its failure with the path and atomicity notice (crates/pi-edit/src/modes/apply_patch.rs:253-259,273,324).
afterEach(() => cleanup());

describe("failed file-operation cards", () => {
  test("shows the file count for a multi-file apply_patch that fails before details exist", () => {
    const args = {
      input:
        "*** Begin Patch\n*** Update File: src/components/main.ts\n@@\n-old\n+new\n*** Add File: src/generated.ts\n+export const value = 1;\n*** End Patch",
    };
    const rendererProps = {
      type: "tool-call",
      toolCallId: "failed-apply-patch",
      toolName: "apply_patch",
      args,
      argsText: JSON.stringify(args),
      result: {
        content: [
          {
            type: "text",
            text: "[src/components/main.ts]: Failed to find expected lines in src/components/main.ts:\nold\nNo files were modified — sections apply atomically.",
          },
        ],
        details: {},
      },
      isError: true,
      status: { type: "complete" },
    } as unknown as ToolRendererProps;

    render(<EditCard rendererProps={rendererProps} />);
    expandToolCards();

    const trigger = screen.getByRole("button", { name: "edit: Error" });
    expect(trigger.textContent).toContain("2 files");
    expect(screen.getByText("Update")).toBeTruthy();
    expect(screen.getByText("Apply failed")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "[src/components/main.ts]: Failed to find expected lines in src/components/main.ts:\nold\nNo files were modified — sections apply atomically.",
    );
  });

  test("does not show zero counts for a failed AST edit and preserves omp's error text", () => {
    const args = {
      ops: [
        { pat: "legacyCall($A)", out: "modernCall($A)" },
        { pat: "legacyCall($A)", out: "modernCall($A)" },
      ],
    };
    const rendererProps = {
      type: "tool-call",
      toolCallId: "failed-ast-edit",
      toolName: "ast_edit",
      args,
      argsText: JSON.stringify(args),
      result: {
        content: [
          {
            type: "text",
            text: "Duplicate rewrite pattern: legacyCall($A)",
          },
        ],
        details: {},
      },
      isError: true,
      status: { type: "complete" },
    } as unknown as ToolRendererProps;

    render(<AstEditCard rendererProps={rendererProps} />);
    expandToolCards();

    const trigger = screen.getByRole("button", { name: "ast_edit: Error" });
    expect(trigger.textContent).toContain("Structural edit failed");
    expect(trigger.textContent).not.toContain("0 replacements");
    expect(screen.getByRole("alert").textContent).toContain(
      "Duplicate rewrite pattern: legacyCall($A)",
    );
  });
});
