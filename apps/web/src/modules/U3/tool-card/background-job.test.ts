import { describe, expect, test } from "vitest";
import { stopCommandFor, stopFailedOutcome, stopOutcomeOf } from "./background-job";

describe("stopCommandFor", () => {
  test("names the card's own job", () => {
    expect(stopCommandFor("bg_1")).toBe("/jobs kill bg_1");
    expect(stopCommandFor("bash_a1b2c3")).toBe("/jobs kill bash_a1b2c3");
  });

  test("never builds a command that stops every job, or one with anything but a job id", () => {
    expect(stopCommandFor("all")).toBeUndefined();
    expect(stopCommandFor("")).toBeUndefined();
    expect(stopCommandFor("bg 1")).toBeUndefined();
    expect(stopCommandFor("bg_1; reboot")).toBeUndefined();
    expect(stopCommandFor("x".repeat(61))).toBeUndefined();
  });
});

describe("stopOutcomeOf", () => {
  test("says the job stopped in plain words", () => {
    expect(stopOutcomeOf(["Cancelled background job bg_1."], "bg_1")).toEqual({
      status: "stopped",
      sentence: "The background command stopped before its result came back.",
    });
  });

  test("says the job already finished when omp has no running job with that id", () => {
    expect(stopOutcomeOf(['No running background job with id "bg_1".'], "bg_1")).toEqual({
      status: "finished",
      sentence: "Already finished: omp has no running job with id bg_1.",
    });
  });

  test("says the stop did not happen when omp could not cancel the job", () => {
    expect(stopOutcomeOf(["Could not cancel background job bg_1."], "bg_1")).toEqual({
      status: "failed",
      sentence: "Could not stop background job bg_1.",
    });
  });

  test("says background jobs are unavailable in this session", () => {
    expect(
      stopOutcomeOf(["Async background jobs are unavailable in this session."], "bg_1"),
    ).toEqual({
      status: "failed",
      sentence: "Background jobs are unavailable in this session.",
    });
  });

  test("joins the texts omp printed, ignoring spaces and line breaks around them", () => {
    expect(stopOutcomeOf(["  Cancelled background job bg_1.\n", " "], "bg_1").status).toBe(
      "stopped",
    );
  });

  test("never reads another job's reply as this card's outcome", () => {
    expect(stopOutcomeOf(["Cancelled background job bg_2."], "bg_1")).toEqual({
      status: "unknown",
      sentence: "omp said: Cancelled background job bg_2.",
    });
  });

  test("says so when omp sent no reply, and shows any other words as omp wrote them", () => {
    expect(stopOutcomeOf([], "bg_1")).toEqual({
      status: "unknown",
      sentence: "omp sent no reply to the stop request.",
    });
    expect(stopOutcomeOf(["Something new."], "bg_1")).toEqual({
      status: "unknown",
      sentence: "omp said: Something new.",
    });
  });
});

describe("stopFailedOutcome", () => {
  test("says the command did not reach omp, with the reason", () => {
    expect(stopFailedOutcome("bg_1", "gateway offline")).toEqual({
      status: "failed",
      sentence: "Could not stop background job bg_1: gateway offline",
    });
  });
});
