import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { T6_REAL_RESULTS } from "../fixtures/real-results";
import { LearnRenderer } from "../learn";
import { ManageSkillRenderer } from "../manage-skill";
import { MemoryEditRenderer } from "../memory-edit";

function recorded(name: string): ToolRendererProps {
  const sample = T6_REAL_RESULTS.find((candidate) => candidate.name === name);
  if (sample === undefined) throw new Error(`Missing recorded T6 sample ${name}.`);
  return {
    toolCallId: `recorded-${sample.toolName}` as never,
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
    result: sample.result,
    isError: sample.isError,
    status: { type: "complete", reason: "stop" },
  } as unknown as ToolRendererProps;
}

function props(
  toolName: string,
  args: unknown,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
  isError = false,
): ToolRendererProps {
  return {
    toolCallId: `${toolName}-test` as never,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    isError,
    status,
  } as unknown as ToolRendererProps;
}

afterEach(cleanup);

describe("T6 plain result labels", () => {
  test("keeps Learn's summary truthful while the call runs, is cancelled, or fails", () => {
    const args = { memory: "Keep this lesson." };
    const statuses = [
      [{ type: "running" }, false, "learn: Running", "Learning memory…"],
      [
        { type: "incomplete", reason: "cancelled" },
        false,
        "learn: Cancelled",
        "Memory learning cancelled",
      ],
      [{ type: "complete", reason: "stop" }, true, "learn: Error", "Memory learning failed"],
    ] as const;
    render(
      statuses.map(([status, isError, accessibleName]) => (
        <LearnRenderer
          key={accessibleName}
          {...props("learn", args, undefined, status as ToolRendererProps["status"], isError)}
        />
      )),
    );
    for (const [, , accessibleName, summary] of statuses) {
      expect(screen.getByRole("button", { name: accessibleName })).toBeTruthy();
      expect(screen.getByText(summary)).toBeTruthy();
    }
    expect(screen.queryByText("Learned")).toBeNull();
  });

  test("uses the recorded Learn result instead of claiming it before completion", () => {
    render(<LearnRenderer {...recorded("learn: a lesson saved as a new managed skill")} />);
    expandToolCards();
    expect(screen.getByRole("button", { name: "learn: Complete" })).toBeTruthy();
    expect(screen.getByText("Memory lesson")).toBeTruthy();
    expect(
      screen.getAllByText(/Lesson queued for retention\. Created managed skill/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Managed skill: sample-skill-one")).toBeTruthy();
    expect(screen.queryByText("Learned · project")).toBeNull();
    expect(screen.queryByText(/Skill create:/)).toBeNull();
  });

  test("shows a recorded managed-skill result without action or status enums", () => {
    render(<ManageSkillRenderer {...recorded("manage_skill: an updated managed skill")} />);
    expandToolCards();
    expect(screen.getByRole("button", { name: "manage_skill: Complete" })).toBeTruthy();
    expect(screen.getByText('Updated managed skill "sample-skill-two".')).toBeTruthy();
    expect(screen.queryByText("update: sample-skill-two")).toBeNull();
    expect(screen.queryByText("Status: updated")).toBeNull();

    fireEvent.click(screen.getByText("Raw details"));
    expect(screen.getByText(/managed-skills\/sample-skill-two\/SKILL\.md/)).toBeTruthy();
  });

  test("shows omp's created managed-skill result sentence", () => {
    const result = {
      content: [
        {
          type: "text",
          text: 'Created managed skill "sample-skill-created" (managed-skills/sample-skill-created/SKILL.md).',
        },
      ],
      details: { action: "create", name: "sample-skill-created" },
    };
    render(
      <ManageSkillRenderer
        {...props("manage_skill", { action: "create", name: "sample-skill-created" }, result)}
      />,
    );
    expandToolCards();
    expect(screen.getByText('Created managed skill "sample-skill-created".')).toBeTruthy();
  });

  test("shows the deleted managed-skill result sentence", () => {
    const result = {
      content: [{ type: "text", text: 'Deleted managed skill "sample-skill-deleted".' }],
      details: { action: "delete", name: "sample-skill-deleted" },
    };
    render(
      <ManageSkillRenderer
        {...props("manage_skill", { action: "delete", name: "sample-skill-deleted" }, result)}
      />,
    );
    expandToolCards();
    expect(screen.getByText('Deleted managed skill "sample-skill-deleted".')).toBeTruthy();
  });

  test("shows omp's shadowed-skill error, not its status code", () => {
    // Exact builder result from omp v18.9.1 packages/coding-agent/src/tools/manage-skill.ts.
    const result = {
      content: [
        {
          type: "text",
          text: 'Cannot create managed skill "release": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.',
        },
      ],
      details: { action: "create", name: "release", shadowed: true },
    };
    render(
      <ManageSkillRenderer
        {...props("manage_skill", { action: "create", name: "release" }, result, undefined, true)}
      />,
    );
    expandToolCards();
    expect(screen.getByRole("alert").textContent).toContain("an authored skill of that name");
    expect(screen.queryByText("shadowed")).toBeNull();
    expect(screen.queryByText("Status: shadowed")).toBeNull();
  });

  test("shows omp's not-found and read-only memory edit sentences without status labels", () => {
    // Text/details shapes and sentences are from omp v18.9.1 packages/coding-agent/src/tools/memory-edit.ts:57-67.
    const notFound = {
      content: [
        {
          type: "text",
          text: "Memory missing-memory was not found in bank project (working).",
        },
      ],
      details: { status: "not_found", id: "missing-memory", bank: "project", store: "working" },
    };
    const readOnly = {
      content: [
        {
          type: "text",
          text: "Memory fact-1 is a read-only fact in bank project (working); it cannot be edited. Read it with memory://fact-1.",
        },
      ],
      details: { status: "not_editable", id: "fact-1", bank: "project", store: "working" },
    };
    const { rerender } = render(
      <MemoryEditRenderer
        {...props("memory_edit", { op: "forget", id: "missing-memory" }, notFound)}
      />,
    );
    expandToolCards();
    expect(screen.getByRole("button", { name: "memory_edit: Complete" })).toBeTruthy();
    expect(
      screen.getByText("Memory missing-memory was not found in bank project (working)."),
    ).toBeTruthy();
    expect(screen.queryByText("Confirmation: not_found")).toBeNull();
    expect(screen.queryByText(/Updated memory:/)).toBeNull();
    fireEvent.click(screen.getByText("Raw details"));
    expect(screen.getByText(/not_found/)).toBeTruthy();

    rerender(
      <MemoryEditRenderer {...props("memory_edit", { op: "update", id: "fact-1" }, readOnly)} />,
    );
    expandToolCards();
    expect(
      screen.getByText(
        "Memory fact-1 is a read-only fact in bank project (working); it cannot be edited. Read it with memory://fact-1.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Confirmation: not_editable")).toBeNull();
  });

  test("memory edit labels stay neutral for running, cancelled, and error phases", () => {
    render(
      <>
        <MemoryEditRenderer
          {...props("memory_edit", { op: "update", id: "secret-id" }, undefined, {
            type: "running",
          })}
        />
        <MemoryEditRenderer
          {...props("memory_edit", { op: "forget", id: "secret-id" }, undefined, {
            type: "incomplete",
            reason: "cancelled",
          })}
        />
        <MemoryEditRenderer
          {...props(
            "memory_edit",
            { op: "invalidate", id: "secret-id" },
            undefined,
            undefined,
            true,
          )}
        />
      </>,
    );
    expect(screen.getByRole("button", { name: "memory_edit: Running" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "memory_edit: Cancelled" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "memory_edit: Error" })).toBeTruthy();
    expect(screen.getByText("Editing memory…")).toBeTruthy();
    expect(screen.getByText("Memory edit cancelled")).toBeTruthy();
    expect(screen.getByText("Memory edit failed")).toBeTruthy();
    expect(
      screen
        .getAllByRole("button")
        .every((button) => !button.getAttribute("aria-label")?.includes("secret-id")),
    ).toBe(true);
  });
  test("shows the forgotten fallback when omp returns no text", () => {
    render(
      <MemoryEditRenderer
        {...props(
          "memory_edit",
          { op: "forget", id: "old-memory" },
          {
            details: { status: "forgotten", id: "old-memory" },
          },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Memory forgotten.")).toBeTruthy();
  });

  test("labels a completed forget operation as Forget memory", () => {
    render(
      <MemoryEditRenderer
        {...props(
          "memory_edit",
          { op: "forget", id: "old-memory" },
          {
            details: { status: "forgotten", id: "old-memory" },
          },
        )}
      />,
    );
    expect(screen.getByText("Forget memory")).toBeTruthy();
    expect(screen.queryByText("Edit memory")).toBeNull();
  });
});
