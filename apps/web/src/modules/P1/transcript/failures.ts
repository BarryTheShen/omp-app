import { AppFailure } from "@omp-app/contracts";

/** A thrown value as a typed failure; anything that is not one is a bug the app reports as internal. */
export function asAppFailure(error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    { code: "internal", message: "The transcript request failed unexpectedly", retryable: true },
    { cause: error },
  );
}

/** The words a person reads when the transcript cannot be read; omp's own error text is never shown. */
export function transcriptFailureMessage(failure: AppFailure): string {
  switch (failure.appError.code) {
    case "unavailable":
      return "Reading this worker's transcript isn't available in this version of omp.";
    case "not_found":
      return "This worker's transcript is no longer available.";
    case "timeout":
      return "Reading the transcript took too long.";
    case "omp_exited":
      return "omp stopped before it could read the transcript.";
    default:
      return "The transcript could not be read.";
  }
}
