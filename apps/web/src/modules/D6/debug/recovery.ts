import { AppFailure } from "@omp-app/contracts";
import type { RecoveryAction, RecoveryActionResult } from "../contract";
import {
  isScrubbedDiagnosticText,
  RecoveryActionResultSchema,
  RecoveryActionSchema,
  redactDiagnosticText,
} from "../contract";

export type RecoveryActionHandler = (action: RecoveryAction) => void | Promise<void>;

export function safeRecoveryText(text: string, fallback: string): string {
  const redacted = redactDiagnosticText(text).text;
  return isScrubbedDiagnosticText(redacted) ? redacted : fallback;
}

/** Run only an available action and turn validation or execution failures into typed results. */
export async function runRecoveryAction(
  action: RecoveryAction,
  execute?: RecoveryActionHandler,
): Promise<RecoveryActionResult> {
  let parsed: RecoveryAction;
  try {
    parsed = RecoveryActionSchema.parse(action);
  } catch {
    return RecoveryActionResultSchema.parse({
      actionId: "unknown",
      status: "failed",
      error: {
        code: "invalid_args",
        message: "The recovery action could not be validated.",
        retryable: false,
      },
    });
  }
  if (parsed.availability.state === "unavailable") {
    return RecoveryActionResultSchema.parse({
      actionId: parsed.id,
      status: "unavailable",
      error: {
        code: "unavailable",
        message: safeRecoveryText(
          parsed.availability.reason,
          "This recovery action is unavailable.",
        ),
        retryable: false,
      },
    });
  }
  if (execute === undefined) {
    return RecoveryActionResultSchema.parse({
      actionId: parsed.id,
      status: "unavailable",
      error: {
        code: "unavailable",
        message: "This recovery action is not connected.",
        retryable: false,
      },
    });
  }
  try {
    await execute(parsed);
    return RecoveryActionResultSchema.parse({ actionId: parsed.id, status: "completed" });
  } catch (error) {
    const text =
      error instanceof AppFailure
        ? error.appError.message
        : error instanceof Error
          ? error.message
          : "The recovery action failed.";
    return RecoveryActionResultSchema.parse({
      actionId: parsed.id,
      status: "failed",
      error: {
        code: error instanceof AppFailure ? error.appError.code : "internal",
        message: safeRecoveryText(
          text,
          "The recovery action failed. Sensitive details were hidden.",
        ),
        retryable: error instanceof AppFailure ? error.appError.retryable : true,
      },
    });
  }
}
