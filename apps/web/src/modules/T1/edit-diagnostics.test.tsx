import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { EditCard } from "./edit";

// omp v18.8.9 sets `errored` if any message is severity 1 (`packages/coding-agent/src/lsp/diagnostics.ts:522-530`), and each message line includes its own severity (`packages/coding-agent/src/lsp/utils.ts:120-132,195-202`). Clean output is `{ summary: "OK", messages: [], errored: false }` (`diagnostics.ts:501-507`). The message samples below are hand-constructed in that format.
const diagnostics = {
  server: "patch",
  messages: ["patch: whitespace only"],
  summary: "Patch warnings: 1",
  errored: false,
};

afterEach(() => cleanup());

describe("edit diagnostics", () => {
  test("keeps a successful edit successful and renders omp diagnostics with its diff", () => {
    const args = { path: "src/math.ts", oldText: "const value = 1;", newText: "const value = 2;" };
    const rendererProps = {
      type: "tool-call",
      toolCallId: "edit-diagnostics-success",
      toolName: "edit",
      args,
      argsText: JSON.stringify(args),
      result: {
        content: [{ type: "text", text: "Edit completed." }],
        details: {
          path: "src/math.ts",
          op: "update",
          diff: "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;",
          diagnostics,
        },
      },
      status: { type: "complete" },
    } as unknown as ToolRendererProps;

    render(<EditCard rendererProps={rendererProps} />);
    expandToolCards();

    expect(screen.getByRole("button", { name: "edit: Complete" })).toBeTruthy();
    expect(screen.getByText("Applied")).toBeTruthy();
    expect(screen.getByText("+const value = 2;")).toBeTruthy();
    expect(screen.getByText("-const value = 1;")).toBeTruthy();
    expect(screen.getByText("Patch warnings: 1")).toBeTruthy();
    expect(screen.getByText("patch: whitespace only")).toBeTruthy();
    expect(screen.getByText("Patch warnings: 1").parentElement?.className).toContain(
      "text-warning",
    );
    expect(screen.queryByText("Malformed edit details")).toBeNull();
  });

  test("keeps mixed-severity message text intact and the successful tool lifecycle", () => {
    const args = { path: "src/math.ts" };
    const errorMessage = "src/math.ts:1:1 [error] unresolved name";
    const warningMessage = "src/math.ts:2:1 [warning] unused binding";
    const rendererProps = {
      type: "tool-call",
      toolCallId: "edit-diagnostics-errored",
      toolName: "edit",
      args,
      argsText: JSON.stringify(args),
      result: {
        content: [{ type: "text", text: "Edit completed." }],
        details: {
          path: "src/math.ts",
          op: "update",
          diff: "@@ -1 +1 @@\n-old\n+new",
          diagnostics: {
            ...diagnostics,
            messages: [errorMessage, warningMessage],
            summary: "one error and one warning",
            errored: true,
          },
        },
      },
      status: { type: "complete" },
    } as unknown as ToolRendererProps;

    render(<EditCard rendererProps={rendererProps} />);
    expandToolCards();

    expect(screen.getByRole("button", { name: "edit: Complete" })).toBeTruthy();
    expect(screen.getByText(errorMessage)).toBeTruthy();
    expect(screen.getByText(warningMessage)).toBeTruthy();
    expect(screen.queryByText(`Error: ${errorMessage}`)).toBeNull();
    expect(screen.queryByText(`Error: ${warningMessage}`)).toBeNull();
    expect(screen.getByText(warningMessage).parentElement?.className).toContain("text-danger");
  });

  test("shows a clean diagnostics summary in the neutral color", () => {
    const args = { path: "src/math.ts" };
    const rendererProps = {
      type: "tool-call",
      toolCallId: "edit-diagnostics-clean",
      toolName: "edit",
      args,
      argsText: JSON.stringify(args),
      result: {
        content: [{ type: "text", text: "Edit completed." }],
        details: {
          path: "src/math.ts",
          op: "update",
          diff: "@@ -1 +1 @@\n-old\n+new",
          diagnostics: { ...diagnostics, messages: [], summary: "OK" },
        },
      },
      status: { type: "complete" },
    } as unknown as ToolRendererProps;

    render(<EditCard rendererProps={rendererProps} />);
    expandToolCards();

    const summary = screen.getByText("OK");
    expect(summary.parentElement?.className).toContain("text-muted-foreground");
    expect(summary.parentElement?.className).not.toContain("text-warning");
  });
});
