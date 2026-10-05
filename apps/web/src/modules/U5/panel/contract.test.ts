import { AppError, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  PanelActionAvailability,
  PanelLifecycle,
  PanelOpenReason,
  PanelPosition,
  PanelState,
} from "./contract";
import {
  canTransitionPanelLifecycle,
  PANEL_KIND_RULES,
  PANEL_LIFECYCLE_TRANSITIONS,
} from "./rules";

describe("U5 panel lifecycle contract", () => {
  test("accepts every explicit lifecycle and rejects unknown states", () => {
    for (const state of PANEL_KIND_RULES.lifecycleStates) {
      expect(PanelLifecycle.safeParse(state).success).toBe(true);
    }
    expect(PanelLifecycle.safeParse("streaming").success).toBe(false);
    expect(PanelPosition.safeParse("right").success).toBe(true);
    expect(PanelOpenReason.safeParse("escape").success).toBe(true);
  });

  test("allows loading/populated/update/close edges but rejects impossible closed transitions", () => {
    expect(canTransitionPanelLifecycle("closed", "loading")).toBe(true);
    expect(canTransitionPanelLifecycle("loading", "populated")).toBe(true);
    expect(canTransitionPanelLifecycle("populated", "updating")).toBe(true);
    expect(canTransitionPanelLifecycle("updating", "populated")).toBe(true);
    expect(canTransitionPanelLifecycle("closed", "updating")).toBe(false);
    expect(canTransitionPanelLifecycle("closed", "error")).toBe(false);
    expect(PANEL_LIFECYCLE_TRANSITIONS.error).toContain("closed");
  });

  test("keeps panel errors and unavailable actions typed", () => {
    const error = AppError.parse({ code: "timeout", message: "Retry", retryable: true });
    expect(
      PanelState.parse({
        open: true,
        lifecycle: "error",
        position: "right",
        title: "Todo",
        error,
        readOnly: true,
        pendingUpdates: 2,
      }),
    ).toMatchObject({ lifecycle: "error", readOnly: true });
    expect(PanelActionAvailability.parse({ state: "available" })).toEqual({ state: "available" });
    expect(
      PanelActionAvailability.parse({
        state: "unavailable",
        reason: "setTodos is unavailable",
        capability: "omp.cmd.set_todos",
      }),
    ).toMatchObject({ state: "unavailable" });
    expect(PanelActionAvailability.safeParse({ state: "unavailable" }).success).toBe(false);
    expect(ThreadId.safeParse("thread-1").success).toBe(true);
  });
});
