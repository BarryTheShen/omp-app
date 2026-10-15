import { describe, expect, test } from "vitest";
import type { StopOutcome } from "./background-job";
import { keptStopOutcome, outcomeOfRecordedStop, resolveStopOutcome } from "./stopped-jobs";

const stopped = { jobId: "bg_1", status: "stopped", at: 2_000 } as const;

describe("the outcome a card shows for a stop the server kept", () => {
  test("a stopped job reads as stopped, and a job omp had finished reads as already finished", () => {
    expect(outcomeOfRecordedStop({ jobId: "bg_1", status: "stopped", at: 1 })).toEqual({
      status: "stopped",
      sentence: "Stopped background job bg_1.",
    });
    expect(outcomeOfRecordedStop({ jobId: "bg_2", status: "finished", at: 1 })).toEqual({
      status: "finished",
      sentence: "Already finished: omp has no running job with id bg_2.",
    });
  });
});

describe("which kept stop applies to a card", () => {
  test("a stop recorded after the card's launch is the card's own stop", () => {
    expect(keptStopOutcome(stopped, 1_000)).toEqual({
      status: "stopped",
      sentence: "Stopped background job bg_1.",
    });
  });

  test("two cards with the same job id: the earlier card reads the stop, a card launched after it does not", () => {
    // omp restarted between the two launches, so both jobs are bg_1, and the stop was made for the first one.
    const firstCardLaunch = 1_000;
    const secondCardLaunch = 3_000;
    expect(keptStopOutcome(stopped, firstCardLaunch)?.status).toBe("stopped");
    expect(keptStopOutcome(stopped, secondCardLaunch)).toBeUndefined();
  });

  test("a card launched after the stop keeps its Stop control while its job runs", () => {
    const second = keptStopOutcome(stopped, 3_000);
    expect(resolveStopOutcome(undefined, true, () => second)).toBeUndefined();
  });

  test("a card whose launch time is unknown takes no kept stop", () => {
    expect(keptStopOutcome(stopped, undefined)).toBeUndefined();
  });

  test("no kept stop for the job means no outcome", () => {
    expect(keptStopOutcome(undefined, 1_000)).toBeUndefined();
  });
});

describe("which stop a card shows", () => {
  const kept: StopOutcome = { status: "stopped", sentence: "Stopped background job bg_1." };

  test("a stop that arrived on this page always wins over the kept stop", () => {
    const live: StopOutcome = { status: "failed", sentence: "Could not stop background job bg_1." };
    expect(resolveStopOutcome(live, true, () => kept)).toEqual(live);
  });

  test("a job the transcript still shows as running takes the kept stop after a reload", () => {
    expect(resolveStopOutcome(undefined, true, () => kept)).toEqual(kept);
  });

  test("a job the transcript shows as finished or ended keeps its own reading", () => {
    expect(resolveStopOutcome(undefined, false, () => kept)).toBeUndefined();
  });

  test("the kept stop is not read at all when a stop on this page already decides the card", () => {
    let reads = 0;
    const live: StopOutcome = { status: "stopped", sentence: "Stopped background job bg_1." };
    expect(
      resolveStopOutcome(live, true, () => {
        reads += 1;
        return kept;
      }),
    ).toEqual(live);
    expect(reads).toBe(0);
  });
});
