import type { AppError } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";

/** A failure whose message is plain text the person can read; a run never shows an internal detail. */
export function runFailure(
  code: AppError["code"],
  message: string,
  retryable: boolean,
): AppFailure {
  return new AppFailure({ code, message, retryable });
}

/** The message R0 gives a branch omp cancelled. A cancelled edit shows it when no editor holds its text. */
export const CANCELLED_BRANCH_MESSAGE = "omp cancelled the branch";
