import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { GuidedGoalSnapshot } from "./controller";
import { GuidedGoalView, type GuidedGoalViewProps } from "./view";

afterEach(cleanup);

function snapshot(patch: Partial<GuidedGoalSnapshot> = {}): GuidedGoalSnapshot {
  return { status: "idle", notice: null, error: null, createReason: null, ...patch };
}

function renderView(patch: Partial<GuidedGoalSnapshot> = {}) {
  const props: GuidedGoalViewProps = {
    snapshot: snapshot(patch),
    onStart: vi.fn(),
    onRetry: vi.fn(),
  };
  render(<GuidedGoalView {...props} />);
  return props;
}

describe("GuidedGoalView", () => {
  test("offers the interview with its description before anything has started", () => {
    const props = renderView();

    expect(screen.getByRole("heading", { name: "Guided goal" })).toBeTruthy();
    expect(
      screen.getByText(
        "omp asks you questions in dialogs, shows the goal for review, and creates it only when you confirm.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start guided goal" }));
    expect(props.onStart).toHaveBeenCalledTimes(1);
  });

  test("a goal that cannot be created right now disables the start and says why", () => {
    renderView({ createReason: "A goal is already active. Drop it before creating another." });

    expect(screen.getByRole("button", { name: "Start guided goal" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      screen.getByText("A goal is already active. Drop it before creating another."),
    ).toBeTruthy();
  });

  test("a paused goal's reason is shown as omp words it", () => {
    renderView({ createReason: "Resume or drop the paused goal before creating another." });

    expect(
      screen.getByText("Resume or drop the paused goal before creating another."),
    ).toBeTruthy();
  });

  test("while the dialogs are open the section says so and nothing can be started", () => {
    renderView({ status: "interviewing" });

    expect(
      screen.getByText("Answer the questions in the dialog. Nothing is created until you confirm."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Interview in progress" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("while omp creates the goal the section says so", () => {
    renderView({ status: "creating" });

    expect(screen.getByText("Creating the goal…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Creating goal…" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  test("a created goal says that omp works on it once the person sends a message", () => {
    renderView({
      status: "created",
      notice: "Goal created. omp works on it once you send a message.",
    });

    expect(screen.getByText("Goal created. omp works on it once you send a message.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start guided goal" })).toBeTruthy();
  });

  test("a cancelled interview shows its notice and offers to start again", () => {
    const props = renderView({
      status: "cancelled",
      notice: "Interview cancelled. No goal was created. The goal text is in the message box.",
    });

    expect(
      screen.getByText(
        "Interview cancelled. No goal was created. The goal text is in the message box.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(props.onStart).toHaveBeenCalledTimes(1);
  });

  test("a failed create shows omp's reason and retries when omp says it can be retried", () => {
    const error = new AppFailure({
      code: "unavailable",
      message: "The goal could not be created.",
      retryable: true,
    }).appError;
    const props = renderView({ status: "failed", error });

    expect(screen.getByText("The goal could not be created.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
  });

  test("a failed create that cannot be retried offers no Try again", () => {
    const error = new AppFailure({
      code: "omp_error",
      message: "A goal is already active.",
      retryable: false,
    }).appError;
    renderView({ status: "failed", error });

    expect(screen.getByText("A goal is already active.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
