import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import type { RecoveryAction } from "../contract";
import { runRecoveryAction } from "./recovery";

const AVAILABLE: RecoveryAction = {
  id: "reconnect",
  kind: "reconnect",
  label: "Reconnect",
  availability: { state: "available" },
};

const UNAVAILABLE: RecoveryAction = {
  id: "clear-local",
  kind: "clear-local",
  label: "Clear saved report",
  availability: { state: "unavailable", reason: "This action needs a saved report." },
};

describe("recovery actions", () => {
  test("does not run an unavailable action and returns its reason", async () => {
    const execute = vi.fn();

    await expect(runRecoveryAction(UNAVAILABLE, execute)).resolves.toEqual({
      actionId: "clear-local",
      status: "unavailable",
      error: {
        code: "unavailable",
        message: "This action needs a saved report.",
        retryable: false,
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("runs an available action once and reports completion", async () => {
    const execute = vi.fn();

    await expect(runRecoveryAction(AVAILABLE, execute)).resolves.toEqual({
      actionId: "reconnect",
      status: "completed",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(AVAILABLE);
  });

  test("shows a visible unavailable result when an action is not connected", async () => {
    await expect(runRecoveryAction(AVAILABLE)).resolves.toMatchObject({
      actionId: "reconnect",
      status: "unavailable",
      error: { code: "unavailable", retryable: false },
    });
  });

  test("returns a typed failure and redacts sensitive details", async () => {
    const secret = ["Bearer", "a".repeat(16)].join(" ");
    const privatePath = ["/home", "person", "private.log"].join("/");
    const execute = vi.fn(() => {
      throw new AppFailure({
        code: "internal",
        message: `Couldn't connect to ${secret} at ${privatePath}`,
        retryable: true,
      });
    });

    await expect(runRecoveryAction(AVAILABLE, execute)).resolves.toEqual({
      actionId: "reconnect",
      status: "failed",
      error: {
        code: "internal",
        message: "Couldn't connect to Bearer <REDACTED:TOKEN> at <REDACTED:PATH>",
        retryable: true,
      },
    });
  });

  test("hides path formats the diagnostic redactor does not recognize", async () => {
    const privatePath = ["C:", "Users", "person", "private.log"].join("\\");
    const execute = vi.fn(() => {
      throw new Error(`The report was written to ${privatePath}`);
    });

    await expect(runRecoveryAction(AVAILABLE, execute)).resolves.toMatchObject({
      status: "failed",
      error: {
        message: "The recovery action failed. Sensitive details were hidden.",
      },
    });
  });

  test("uses a fixed safe message when action schema validation fails", async () => {
    const execute = vi.fn();
    const invalid = { ...AVAILABLE, extra: true } as RecoveryAction;

    await expect(runRecoveryAction(invalid, execute)).resolves.toEqual({
      actionId: "unknown",
      status: "failed",
      error: {
        code: "invalid_args",
        message: "The recovery action could not be validated.",
        retryable: false,
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
