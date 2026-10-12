import { ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { PanelShell } from "../../panel/shell";
import type { TodoSnapshot } from "../contract";
import { projectTodoSnapshot } from "../model";
import { TodoChecklist } from "./checklist";

const threadId = ThreadId.parse("u5-checklist");

function model(status: "pending" | "in_progress" = "in_progress") {
  const snapshot: TodoSnapshot = {
    threadId,
    phases: [
      {
        name: "Finished",
        tasks: [{ content: "Ship release", status: "completed" }],
      },
      {
        name: "Current",
        tasks: [
          { content: "Write tests", status },
          { content: "Review notes", status: "pending", details: "Keep this visible" },
          { content: "Blocked task", status: "blocked", blocker: "CI" },
          { content: "Cancelled task", status: "abandoned" },
        ],
      },
    ],
    source: "state",
    sequence: 1,
    updatedAt: "2026-10-05T00:00:00.000Z",
    reminder: null,
    error: null,
  };
  return projectTodoSnapshot(snapshot);
}

afterEach(() => cleanup());

describe("TodoChecklist", () => {
  test("renders progress, status labels, current task, details, and reduced-motion loading", () => {
    render(<TodoChecklist model={model()} />);

    expect(screen.getByTestId("todo-progress").textContent).toBe("2 of 5 done");
    expect(screen.getByText("Write tests").closest("li")?.getAttribute("data-current")).toBe(
      "true",
    );
    expect(screen.getByText("Review notes")).toBeTruthy();
    expect(screen.getByText("Keep this visible")).toBeTruthy();
    expect(screen.getByText("Blocked by: CI")).toBeTruthy();
    const currentIcon = screen
      .getByText("Write tests")
      .closest("li")
      ?.querySelector("[data-testid^='todo-status-']");
    expect(currentIcon?.getAttribute("class")).toContain("motion-reduce:animate-none");
    expect(screen.getByText("In progress")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand Finished" }));
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
    const pendingIcon = screen
      .getByText("Review notes")
      .closest("li")
      ?.querySelector("[data-testid^='todo-status-']");
    expect(pendingIcon?.getAttribute("class")).toContain("rounded-full");
    const cancelledIcon = screen
      .getByText("Cancelled task")
      .closest("li")
      ?.querySelector("[data-testid^='todo-status-']");
    expect(cancelledIcon?.tagName.toLowerCase()).toBe("svg");
  });

  test("collapses finished phases by default and supports keyboard-reachable expansion", () => {
    render(<TodoChecklist model={model()} />);
    const toggle = screen.getByRole("button", { name: "Expand Finished" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Ship release")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Ship release")).toBeTruthy();
  });

  test("passive model updates preserve focus and do not change manual disclosure", () => {
    const first = model();
    const { rerender } = render(<TodoChecklist model={first} />);
    const toggle = screen.getByRole("button", { name: "Collapse Current" });
    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    rerender(<TodoChecklist model={model("pending")} />);
    expect(document.activeElement).toBe(toggle);
    expect(
      screen.getByRole("button", { name: "Collapse Current" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("inside the todo panel the title is the only heading, and the progress line stays", () => {
    render(
      <PanelShell
        body={<TodoChecklist model={model()} />}
        state={{
          open: true,
          lifecycle: "populated",
          position: "right",
          title: "Todo checklist",
          error: null,
          readOnly: true,
          pendingUpdates: 0,
        }}
        onOpenChange={() => undefined}
      />,
    );
    expect(screen.getAllByRole("heading", { name: "Todo checklist" })).toHaveLength(1);
    expect(screen.getByTestId("todo-progress").textContent).toBe("2 of 5 done");
  });

  test("inside the todo panel one region is named Todo checklist: the panel's own", () => {
    render(
      <PanelShell
        body={<TodoChecklist model={model()} />}
        state={{
          open: true,
          lifecycle: "populated",
          position: "right",
          title: "Todo checklist",
          error: null,
          readOnly: true,
          pendingUpdates: 0,
        }}
        onOpenChange={() => undefined}
      />,
    );
    expect(screen.getAllByRole("region", { name: "Todo checklist" })).toHaveLength(1);
  });
});
