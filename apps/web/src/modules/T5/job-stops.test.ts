import { describe, expect, test } from "vitest";
import { stopAllCountOf, stopAllOutcomeOf } from "./job-stops";

describe("T5 Tasks view: omp's words for /jobs kill all", () => {
  test("a count of cancelled jobs reads as stopped, with the count in plain words", () => {
    expect(stopAllOutcomeOf(["Cancelled 2 background jobs."])).toEqual({
      status: "stopped",
      sentence: "Stopped 2 background jobs.",
    });
    expect(stopAllOutcomeOf(["Cancelled 1 background job."])).toEqual({
      status: "stopped",
      sentence: "Stopped 1 background job.",
    });
  });

  test("no running job reads as already finished", () => {
    expect(stopAllOutcomeOf(["No running background jobs to cancel."])).toEqual({
      status: "finished",
      sentence: "Already finished: omp has no running background jobs to stop.",
    });
  });

  test("an empty reply says so, and any other words are shown as omp wrote them", () => {
    expect(stopAllOutcomeOf([])).toEqual({
      status: "unknown",
      sentence: "omp sent no reply to the stop request.",
    });
    expect(stopAllOutcomeOf(["Something new  from omp."])).toEqual({
      status: "unknown",
      sentence: "omp said: Something new from omp.",
    });
  });

  test("omp's count of stopped jobs is read from its words, and the other answers give none", () => {
    expect(stopAllCountOf(["Cancelled 3 background jobs."])).toBe(3);
    expect(stopAllCountOf(["Cancelled 1 background job."])).toBe(1);
    expect(stopAllCountOf(["No running background jobs to cancel."])).toBeUndefined();
    expect(stopAllCountOf([])).toBeUndefined();
  });
});
