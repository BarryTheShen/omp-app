import { AppFailure, type CommandRunResult } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { AdvisorState } from "../contract";
import { createAdvisorCommandController } from "./advisor";
import { AdvisorStatusChip } from "./status-chip";

afterEach(cleanup);

const advisorState: AdvisorState = { mode: "unknown", status: "unknown", note: null };
const commandResult: CommandRunResult = {
  command: "/advisor status",
  status: "completed",
  agentInvoked: false,
  promptSettled: true,
  sessionSettled: true,
  outputs: [],
  sessionUpdates: [],
  configUpdates: [],
};

describe("advisor status chip command feedback", () => {
  test("hides the ready word while idle and shows command progress then completion", async () => {
    const gate = Promise.withResolvers<CommandRunResult>();
    const commands = createAdvisorCommandController({ run: () => gate.promise });
    render(<AdvisorStatusChip state={advisorState} commands={commands} />);
    expect(screen.queryByText("Ready")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(screen.getByText("Working")).toBeTruthy();
    gate.resolve(commandResult);
    await waitFor(() => expect(screen.getByText("Finished")).toBeTruthy());
    expect(screen.getByText("Advisor: Unknown")).toBeTruthy();
  });

  test("shows a failed command result beside the status chip", async () => {
    const failure = new AppFailure({
      code: "unavailable",
      message: "Advisor status could not be read.",
      retryable: false,
    });
    const commands = createAdvisorCommandController({
      run: async () => {
        throw failure;
      },
    });
    render(<AdvisorStatusChip state={advisorState} commands={commands} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(screen.getByText("Could not complete")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("Advisor status could not be read.");
  });
});
