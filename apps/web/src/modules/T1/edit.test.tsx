import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { EditCard } from "./edit";

afterEach(() => cleanup());

function props(
  toolName: string,
  result: unknown,
  args: unknown = { path: "src/math.ts", oldText: "const value = 1;", newText: "const value = 2;" },
  status: ToolRendererProps["status"] = { type: "complete" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: `${toolName}-1`,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

describe("EditCard", () => {
  test("renders a unified diff with U0 diff tokens and header counts", () => {
    render(
      <EditCard
        rendererProps={props("edit", {
          path: "src/math.ts",
          op: "update",
          diff: "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;",
          firstChangedLine: 1,
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("button", { name: "edit: Complete" })).toBeTruthy();
    expect(screen.getByText("src/math.ts")).toBeTruthy();
    expect(screen.getByTestId("t1-edit-stats").textContent).toBe("+1 −1");
    expect(screen.getByText("+const value = 2;").parentElement?.className).toContain(
      "bg-diff-add-surface",
    );
    expect(screen.getByText("-const value = 1;").parentElement?.className).toContain(
      "bg-diff-remove-surface",
    );
  });

  test("shares the renderer for apply_patch while preserving its tool name and grouping files", () => {
    render(
      <EditCard
        rendererProps={props(
          "apply_patch",
          {
            perFileResults: [
              {
                path: "src/a.ts",
                diff: "@@ -1 +1 @@\n-a\n+b",
                op: "update",
              },
              {
                sourcePath: "src/b.ts",
                path: "src/c.ts",
                diff: "@@ -1 +1 @@\n-old\n+new",
                op: "update",
                move: { path: "src/c.ts" },
                diagnostics: {
                  server: "patch",
                  messages: ["patch: Review generated import"],
                  summary: "Patch warnings: 1",
                  errored: false,
                },
              },
            ],
          },
          { patch: "*** Begin Patch\n*** Update File: src/a.ts" },
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("button", { name: "edit: Complete" })).toBeTruthy();
    expect(screen.getAllByTestId("t1-edit-file")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "edit: Complete" }).textContent).toContain(
      "2 files · +2 −2",
    );
    expect(screen.getByText("patch: Review generated import")).toBeTruthy();
    expect(screen.getByText(/src\/b\.ts → src\/c\.ts/)).toBeTruthy();
  });

  test("keeps streaming raw input in the U3 lifecycle shell until details are structured", () => {
    render(
      <EditCard
        rendererProps={props(
          "edit",
          "@@ -1 +1 @@\n-old\n+new",
          { path: "src/live.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
          { type: "running" },
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("button", { name: "edit: Running" })).toBeTruthy();
    expect(screen.getByText("Streaming preview")).toBeTruthy();
    expect(screen.getByTestId("t1-edit-raw-preview").textContent).toContain("@@ -1 +1 @@");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("derives a pending apply_patch target and operation from patch headers", () => {
    render(
      <EditCard
        rendererProps={props(
          "apply_patch",
          undefined,
          { patch: "*** Add File: src/pending.ts\n+export const pending = true;" },
          { type: "running" },
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByText("src/pending.ts")).toBeTruthy();
    expect(screen.getByText("Create")).toBeTruthy();
    expect(screen.getByText("Streaming preview")).toBeTruthy();
  });

  test("shows a neutral no-change state and diagnostics/conflict notices", () => {
    const { rerender } = render(
      <EditCard
        rendererProps={props(
          "edit",
          {
            path: "src/empty.ts",
            op: "update",
            diagnostics: {
              server: "patch",
              messages: [],
              summary: "No matching lines",
              errored: false,
            },
            conflict: "Hashline changed before apply",
          },
          { path: "src/empty.ts" },
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByText("No changes were made.")).toBeTruthy();
    expect(screen.getByText("No matching lines")).toBeTruthy();
    expect(screen.getByText("Conflict: Hashline changed before apply")).toBeTruthy();

    rerender(
      <EditCard
        rendererProps={props(
          "edit",
          {
            path: "src/empty.ts",
            op: "update",
            snapshotsPruned: true,
          },
          { path: "src/empty.ts" },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText(/Source snapshots were shortened/)).toBeTruthy();
  });

  test("surfaces structured apply failures as an error state", () => {
    render(
      <EditCard
        rendererProps={props("edit", {
          path: "src/blocked.ts",
          error: "Hashline no longer matches",
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("button", { name: "edit: Error" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Hashline no longer matches");
  });

  test("keeps cancelled partial output visible without converting it to success", () => {
    render(
      <EditCard
        rendererProps={props(
          "edit",
          "@@ -1 +1 @@\n-old\n+new",
          { path: "src/cancelled.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
          { type: "incomplete", reason: "cancelled" },
        )}
      />,
    );
    expandToolCards();

    expect(screen.getByRole("button", { name: "edit: Cancelled" })).toBeTruthy();
    expect(screen.getByText("Streaming preview")).toBeTruthy();
  });

  test("maps malformed settled details to a typed error that shows once the card opens and retains raw output", () => {
    render(<EditCard rendererProps={props("edit", "not-an-object")} />);
    expandToolCards();

    expect(screen.getByRole("alert").textContent).toContain("Malformed edit details");
    expect(screen.getByText("not-an-object")).toBeTruthy();
    expect(screen.getByRole("button", { name: "edit: Error" })).toBeTruthy();
  });

  test("copies the source string through the explicit edit callback", async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    render(
      <EditCard
        onCopy={onCopy}
        rendererProps={props("edit", {
          path: "src/math.ts",
          diff: "@@ -1 +1 @@\n-old\n+new",
        })}
      />,
    );
    expandToolCards();

    fireEvent.click(screen.getByRole("button", { name: "Copy diff" }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith("@@ -1 +1 @@\n-old\n+new", "code"));
  });
});
