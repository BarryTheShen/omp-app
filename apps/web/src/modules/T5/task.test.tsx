import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { alteredResult, recorded } from "./recorded-props";
import { TaskCard } from "./task";

afterEach(() => cleanup());

describe("T5 task card on recorded results", () => {
  test("one agent started in the background shows its job, its status and its counts", () => {
    render(<TaskCard rendererProps={recorded("task: one agent started in the background")} />);
    expect(screen.getByTestId("t5-task-card")).toBeTruthy();
    expect(screen.getByText("Running · 1 agent")).toBeTruthy();
    expect(screen.getByText("Background job BuilderTwo")).toBeTruthy();
    expect(screen.getByText("BuilderTwo")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Build one part of the app and open its pull request.")).toBeTruthy();
  });

  test("two reviewers started in the background show each agent", () => {
    render(<TaskCard rendererProps={recorded("task: two reviewers started in the background")} />);
    expect(screen.getByText("Running · 2 agents")).toBeTruthy();
    expect(screen.getByText("ReviewerOne")).toBeTruthy();
    expect(screen.getByText("ReviewerTwo")).toBeTruthy();
    expect(screen.getAllByText("Pending")).toHaveLength(2);
    expect(
      screen.getAllByText("Review one pull request against its issue and report the findings."),
    ).toHaveLength(2);
  });

  test("a preflight refusal says no agent started and shows the text omp returned", () => {
    render(<TaskCard rendererProps={recorded("task: a preflight failure, no agent started")} />);
    expect(screen.getByText("No agents reported")).toBeTruthy();
    expect(screen.getByTestId("t5-task-text").textContent).toContain("failed preflight");
  });

  test("a refused call shows omp's own words as its reason", () => {
    render(<TaskCard rendererProps={recorded("task: the call was refused")} />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Put each model selector on its tasks[] item, not on the batch container.",
    );
  });

  test("a progress status omp does not send is a visible error", () => {
    const props = alteredResult(
      "task: one agent started in the background",
      ["details", "progress", 0, "status"],
      "paused",
    );
    render(<TaskCard rendererProps={props} />);
    expect(screen.getByRole("alert").textContent).toContain("Malformed task");
  });
});
