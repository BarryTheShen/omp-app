import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { P6_QUEUE_CAPABILITIES, type QueuePort, type QueueSnapshot } from "../../contract";
import { QUEUE_CANCELLATION_POLICY, QueueModeSelector } from "../../modes";

const snapshot: QueueSnapshot = {
  steering: [],
  followUp: [],
  steeringMode: "one-at-a-time",
  followUpMode: "all",
  interruptMode: "immediate",
  isStreaming: true,
};

function fixture(capabilities = true) {
  const setModes = vi.fn(async () => undefined);
  const port = {
    getSnapshot: () => snapshot,
    getCapabilities: () =>
      capabilities
        ? {
            [P6_QUEUE_CAPABILITIES.steeringMode]: { state: "available", via: "omp" },
            [P6_QUEUE_CAPABILITIES.followUpMode]: { state: "available", via: "omp" },
            [P6_QUEUE_CAPABILITIES.interruptMode]: { state: "available", via: "omp" },
          }
        : {},
    subscribe: () => () => undefined,
    setModes,
  } as unknown as QueuePort;
  return { port, setModes };
}

afterEach(cleanup);

describe("QueueModeSelector", () => {
  test("edits all session-scoped modes through QueuePort", async () => {
    const state = fixture();
    render(<QueueModeSelector open onOpenChange={() => undefined} port={state.port} />);

    fireEvent.click(
      within(screen.getByRole("group", { name: "Steering mode" })).getByRole("button", {
        name: "All",
      }),
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "Interrupt mode" })).getByRole("button", {
        name: "Wait",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save modes" }));

    await vi.waitFor(() => expect(state.setModes).toHaveBeenCalledOnce());
    expect(state.setModes).toHaveBeenCalledWith({
      steeringMode: "all",
      followUpMode: undefined,
      interruptMode: "wait",
    });
  });

  test("shows unavailable capability reason and leaves QueuePort untouched", () => {
    const state = fixture(false);
    render(<QueueModeSelector open onOpenChange={() => undefined} port={state.port} />);

    fireEvent.click(
      within(screen.getByRole("group", { name: "After this turn mode" })).getByRole("button", {
        name: "One at a time",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save modes" }));

    expect(screen.getByRole("alert").textContent).toContain("unavailable");
    expect(state.setModes).not.toHaveBeenCalled();
    expect(screen.getByText(QUEUE_CANCELLATION_POLICY)).toBeTruthy();
  });
});
