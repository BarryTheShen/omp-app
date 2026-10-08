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
