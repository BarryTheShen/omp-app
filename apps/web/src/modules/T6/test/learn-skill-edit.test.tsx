import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { LearnRenderer } from "../learn";
import { ManageSkillRenderer } from "../manage-skill";
import { MemoryEditRenderer } from "../memory-edit";

function props(toolName: string, args: unknown, result: unknown): ToolRendererProps {
  return {
    toolCallId: `${toolName}-test` as never,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    status: { type: "complete", reason: "stop" },
  } as unknown as ToolRendererProps;
}

afterEach(cleanup);

describe("T6 learn, manage_skill and memory_edit renderers", () => {
  test("shows learned lesson scope and linked skill status", () => {
    render(
      <LearnRenderer
        {...props(
          "learn",
          {
            memory: "Keep releases browser read-only.",
            scope: "project",
            skill: { action: "create", name: "release" },
          },
          { content: [{ type: "text", text: "Lesson stored." }], details: { skill: "created" } },
        )}
      />,
    );
    expect(screen.getByText("Learned · project")).toBeTruthy();
    expect(screen.getByText("Keep releases browser read-only.")).toBeTruthy();
    expect(screen.getByText(/Skill create: release/)).toBeTruthy();
  });

  test("renders managed skill Markdown preview and edit status", () => {
    render(
      <ManageSkillRenderer
        {...props(
          "manage_skill",
          { action: "update", name: "release", body: "# Release\n\nUse a compact review." },
          {
            content: [{ type: "text", text: "Updated managed skill" }],
            details: { action: "update", name: "release" },
          },
        )}
      />,
    );
    expect(screen.getByText("update: release")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Release" })).toBeTruthy();
    expect(screen.getByText("Status: updated")).toBeTruthy();
  });

  test("shows memory edit target and adapter confirmation", () => {
    render(
      <MemoryEditRenderer
        {...props(
          "memory_edit",
          { op: "forget", id: "memory-1" },
          {
            content: [{ type: "text", text: "Memory memory-1 forgotten." }],
            details: { status: "forgotten", id: "memory-1" },
          },
        )}
      />,
    );
    expect(screen.getAllByText("Forgot memory: memory-1").length).toBeGreaterThan(0);
    expect(screen.getByText("Confirmation: forgotten")).toBeTruthy();
  });
});
