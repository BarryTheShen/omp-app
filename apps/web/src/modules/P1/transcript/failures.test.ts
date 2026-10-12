import { type AppErrorCode, AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { transcriptFailureNotice } from "./failures";

const FINISHED_WITH_FILE = { finished: true, sessionFileKnown: true } as const;
const FINISHED_NO_FILE = { finished: true, sessionFileKnown: false } as const;
const RUNNING_WITH_FILE = { finished: false, sessionFileKnown: true } as const;

const NEVER_SAVED = {
  heading: "No transcript for this worker",
  message: "omp did not save this worker's transcript.",
  canRetry: false,
};

function failure(code: AppErrorCode, retryable = true): AppFailure {
  return new AppFailure({ code, message: "omp detail", retryable });
}

describe("transcriptFailureNotice", () => {
  test("a finished worker with no session file says omp did not save its transcript, whatever omp answered", () => {
    expect(transcriptFailureNotice(failure("omp_error"), FINISHED_NO_FILE)).toEqual(NEVER_SAVED);
    expect(transcriptFailureNotice(failure("not_found", false), FINISHED_NO_FILE)).toEqual(
      NEVER_SAVED,
    );
  });

  test("a finished worker whose known file is missing says omp did not save its transcript, and no retry can help", () => {
    expect(transcriptFailureNotice(failure("not_found", false), FINISHED_WITH_FILE)).toEqual(
      NEVER_SAVED,
    );
  });

  test("a worker still running keeps the plain reason for omp's answer, and Try again can help", () => {
    expect(transcriptFailureNotice(failure("omp_error"), RUNNING_WITH_FILE)).toEqual({
      heading: "The transcript could not be read",
      message: "omp could not read this worker's transcript.",
      canRetry: true,
    });
  });

  test("each reason has its own plain sentence, so the card says why", () => {
    const reasons: ReadonlyArray<readonly [AppErrorCode, string]> = [
      ["unavailable", "Reading this worker's transcript isn't available in this version of omp."],
      ["not_found", "This worker's transcript is no longer available."],
      ["timeout", "Reading the transcript took too long."],
      ["omp_exited", "omp stopped before it could read the transcript."],
      ["omp_error", "omp could not read this worker's transcript."],
      ["invalid_args", "This app cannot find this worker's transcript."],
      ["cancelled", "Reading this worker's transcript was cancelled."],
      ["permission", "This app is not allowed to read this worker's transcript file."],
    ];
    for (const [code, message] of reasons) {
      expect(transcriptFailureNotice(failure(code), RUNNING_WITH_FILE).message).toBe(message);
    }
  });

  test("Try again is offered only for a failure a retry can change", () => {
    expect(transcriptFailureNotice(failure("internal"), RUNNING_WITH_FILE).canRetry).toBe(true);
    expect(
      transcriptFailureNotice(failure("invalid_args", false), RUNNING_WITH_FILE).canRetry,
    ).toBe(false);
  });

  test("an unexpected app error keeps the plain fallback sentence", () => {
    expect(transcriptFailureNotice(failure("internal"), FINISHED_WITH_FILE)).toEqual({
      heading: "The transcript could not be read",
      message: "The transcript could not be read.",
      canRetry: true,
    });
  });
});
