import { AppFailure } from "@omp-app/contracts";

/** A thrown value as a typed failure; anything that is not one is a bug the app reports as internal. */
export function asAppFailure(error: unknown): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    { code: "internal", message: "The transcript request failed unexpectedly", retryable: true },
    { cause: error },
  );
}

/** What the transcript view knows about its worker when a read fails. */
interface TranscriptWorkerFacts {
  /** The worker has ended: its status is neither running nor pending. */
  readonly finished: boolean;
  /** A session file is known for the worker. Without one, omp never saved a transcript for it. */
  readonly sessionFileKnown: boolean;
}

/** What the card shows for a failed read: a heading, the plain reason, and whether Try again can help. */
interface TranscriptFailureNotice {
  readonly heading: string;
  readonly message: string;
  readonly canRetry: boolean;
}

/**
 * A finished worker whose file is not there never had a transcript to read. No read can succeed, so omp's answer is
 * beside the point. The file is not there when no session file is known, or when the known file is missing.
 */
function neverSaved(failure: AppFailure, worker: TranscriptWorkerFacts): boolean {
  return worker.finished && (!worker.sessionFileKnown || failure.appError.code === "not_found");
}

/** The plain reason a read failed. omp's own error text is never shown. */
function reasonFor(failure: AppFailure): string {
  switch (failure.appError.code) {
    case "unavailable":
      return "Reading this worker's transcript isn't available in this version of omp.";
    case "not_found":
      return "This worker's transcript is no longer available.";
    case "timeout":
      return "Reading the transcript took too long.";
    case "omp_exited":
      return "omp stopped before it could read the transcript.";
    case "omp_error":
      return "omp could not read this worker's transcript.";
    case "invalid_args":
      return "This app cannot find this worker's transcript.";
    case "cancelled":
      return "Reading this worker's transcript was cancelled.";
    case "permission":
      return "This app is not allowed to read this worker's transcript file.";
    default:
      return "The transcript could not be read.";
  }
}

/** The card's words for a failed transcript read, and whether Try again can change the result. */
export function transcriptFailureNotice(
  failure: AppFailure,
  worker: TranscriptWorkerFacts,
): TranscriptFailureNotice {
  if (neverSaved(failure, worker)) {
    return {
      heading: "No transcript for this worker",
      message: "omp did not save this worker's transcript.",
      canRetry: false,
    };
  }
  return {
    heading: "The transcript could not be read",
    message: reasonFor(failure),
    canRetry: failure.appError.retryable,
  };
}
