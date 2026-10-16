import type { CommandRunResult } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SurfaceNotice } from "./notice";

afterEach(() => cleanup());

const settled: CommandRunResult = {
  command: "/skillful status",
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [{ text: "Skill listing is off." }, { text: "No skills are shown in prompts." }],
  sessionUpdates: [],
  configUpdates: [],
};

describe("D7.4 typed command output", () => {
  test("renders each omp output verbatim", () => {
    render(
      <SurfaceNotice
        surface={{ state: "complete", command: "/skillful status", result: settled }}
      />,
    );
    expect(screen.getByText("Skill listing is off.")).toBeTruthy();
    expect(screen.getByText("No skills are shown in prompts.")).toBeTruthy();
  });

  test("does not claim success when omp prints nothing", () => {
    render(
      <SurfaceNotice
        surface={{
          state: "complete",
          command: "/prewalk",
          result: { ...settled, command: "/prewalk", outputs: [] },
        }}
      />,
    );
    expect(
      screen.getByText(
        "omp ran the command but printed nothing, so the app cannot confirm it took effect.",
      ),
    ).toBeTruthy();
  });

  test("shows retry for a command error", () => {
    const onRetry = vi.fn();
    render(
      <SurfaceNotice
        onRetry={onRetry}
        surface={{
          state: "error",
          command: "/tools",
          message: "The app could not reach omp. Try again.",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("uses the same Retry label for reconnect recovery", () => {
    const onRetry = vi.fn();
    render(
      <SurfaceNotice
        onRetry={onRetry}
        surface={{
          state: "unknown",
          command: "/prewalk",
          message: "The app reconnected, but omp has not confirmed this state yet.",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
