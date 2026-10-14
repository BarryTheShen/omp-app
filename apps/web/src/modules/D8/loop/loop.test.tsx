import type { CapabilityMap } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LOOP_UNAVAILABLE_REASON, loopGate } from "./gate";
import { loopSpecFromForm } from "./spec";
import { LoopControls, type LoopControlsProps } from "./view";

afterEach(cleanup);

const EMPTY = { count: "", minutes: "", command: "", mode: "until" as const };

describe("loopGate", () => {
  test("is unavailable until omp publishes the loop capability", () => {
    expect(loopGate(undefined)).toEqual({ state: "unavailable", reason: LOOP_UNAVAILABLE_REASON });
    expect(loopGate({})).toEqual({ state: "unavailable", reason: LOOP_UNAVAILABLE_REASON });
  });

  test("is unavailable when the loop capability is present but not available", () => {
    const withdrawn: CapabilityMap = {
      "upstream.loop": { state: "unavailable", via: "rpc", detail: "not in this omp" },
    };
    expect(loopGate(withdrawn).state).toBe("unavailable");
  });

  test("is available only when the loop capability is available", () => {
    const published: CapabilityMap = { "upstream.loop": { state: "available", via: "rpc" } };
    expect(loopGate(published)).toEqual({ state: "available" });
  });
});

describe("loopSpecFromForm", () => {
  test("a count alone is a valid run", () => {
    expect(loopSpecFromForm({ ...EMPTY, count: "10" })).toEqual({ ok: true, spec: { count: 10 } });
  });

  test("a time limit with a condition command carries the mode", () => {
    expect(
      loopSpecFromForm({ ...EMPTY, minutes: "30", command: " bun test ", mode: "while" }),
    ).toEqual({
      ok: true,
      spec: { minutes: 30, condition: { command: "bun test", mode: "while" } },
    });
  });

  test("a run with no bound and no condition is refused", () => {
    expect(loopSpecFromForm(EMPTY)).toEqual({
      ok: false,
      message: "Set a count, a time limit or a condition command.",
    });
  });

  test("a count and a time limit together are refused", () => {
    expect(loopSpecFromForm({ ...EMPTY, count: "2", minutes: "5" })).toEqual({
      ok: false,
      message: "Choose a count or a time limit, not both.",
    });
  });

  test("a count that is not a whole number above zero is refused in plain words", () => {
    expect(loopSpecFromForm({ ...EMPTY, count: "0" })).toEqual({
      ok: false,
      message: "Count must be a whole number above zero.",
    });
  });

  test("a time limit with a fraction is refused in plain words", () => {
    expect(loopSpecFromForm({ ...EMPTY, minutes: "1.5" })).toEqual({
      ok: false,
      message: "Time limit must be a whole number of minutes above zero.",
    });
  });
});

function renderControls(overrides: Partial<LoopControlsProps> = {}) {
  const props: LoopControlsProps = {
    gate: { state: "available" },
    run: "idle",
    onStart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };
  render(<LoopControls {...props} />);
  return props;
}

describe("LoopControls", () => {
  test("shows the reason and no control while loops are unavailable", () => {
    renderControls({ gate: { state: "unavailable", reason: LOOP_UNAVAILABLE_REASON } });
    expect(screen.getByRole("status").textContent).toBe(LOOP_UNAVAILABLE_REASON);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("a blank form is refused with the reason and never starts a loop", () => {
    const props = renderControls();
    fireEvent.click(screen.getByRole("button", { name: "Start loop" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Set a count, a time limit or a condition command.",
    );
    expect(props.onStart).not.toHaveBeenCalled();
  });

  test("a valid form starts the loop with the spec it describes", () => {
    const props = renderControls();
    fireEvent.change(screen.getByLabelText("Count"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Start loop" }));
    expect(props.onStart).toHaveBeenCalledWith({ count: 3 });
  });

  test("a running loop offers pause and stop", () => {
    const props = renderControls({ run: "running" });
    fireEvent.click(screen.getByRole("button", { name: "Pause loop" }));
    expect(props.onPause).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Stop loop" }));
    expect(props.onStop).toHaveBeenCalledOnce();
  });

  test("a paused loop offers resume and stop", () => {
    const props = renderControls({ run: "paused" });
    fireEvent.click(screen.getByRole("button", { name: "Resume loop" }));
    expect(props.onResume).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Stop loop" }));
    expect(props.onStop).toHaveBeenCalledOnce();
  });
});
