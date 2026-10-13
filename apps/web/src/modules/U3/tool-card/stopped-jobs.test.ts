import { beforeEach, describe, expect, test, vi } from "vitest";
import type { StopOutcome } from "./background-job";
import {
  rememberStopped,
  resolveStopOutcome,
  STOPPED_JOBS_LIMIT,
  stopRememberedFor,
} from "./stopped-jobs";

const STORAGE_KEY = "omp-app.stopped-background-jobs";
const stopped: StopOutcome = { status: "stopped", sentence: "Stopped background job bg_1." };

beforeEach(() => {
  localStorage.clear();
});

describe("the browser record of confirmed stops", () => {
  test("remembers a stop per chat and per job, and nothing else", () => {
    rememberStopped("chat-a", "call-1", stopped);

    expect(stopRememberedFor("chat-a", "call-1")).toEqual(stopped);
    expect(stopRememberedFor("chat-b", "call-1")).toBeUndefined();
    expect(stopRememberedFor("chat-a", "call-2")).toBeUndefined();
  });

  test("keeps only the two outcomes that take the Stop control away", () => {
    rememberStopped("chat-a", "call-1", {
      status: "failed",
      sentence: "Could not stop background job bg_1.",
    });
    rememberStopped("chat-a", "call-2", {
      status: "unknown",
      sentence: "omp sent no reply to the stop request.",
    });
    rememberStopped("chat-a", "call-3", {
      status: "finished",
      sentence: "Already finished: omp has no running job with id bg_3.",
    });

    expect(stopRememberedFor("chat-a", "call-1")).toBeUndefined();
    expect(stopRememberedFor("chat-a", "call-2")).toBeUndefined();
    expect(stopRememberedFor("chat-a", "call-3")?.status).toBe("finished");
  });

  test("keeps the most recent stops and drops the oldest on each write", () => {
    for (let index = 0; index <= STOPPED_JOBS_LIMIT; index += 1) {
      rememberStopped("chat-a", `call-${index}`, stopped);
    }

    expect(stopRememberedFor("chat-a", "call-0")).toBeUndefined();
    expect(stopRememberedFor("chat-a", `call-${STOPPED_JOBS_LIMIT}`)).toEqual(stopped);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toHaveLength(STOPPED_JOBS_LIMIT);
  });

  test("a stop remembered again for the same job replaces the earlier one", () => {
    rememberStopped("chat-a", "call-1", { status: "finished", sentence: "Already finished." });
    rememberStopped("chat-a", "call-1", stopped);

    expect(stopRememberedFor("chat-a", "call-1")).toEqual(stopped);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toHaveLength(1);
  });

  test("ignores a stored value that is not valid, and keeps the valid entries beside a broken one", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    localStorage.setItem(STORAGE_KEY, "not json");
    expect(stopRememberedFor("chat-a", "call-1")).toBeUndefined();

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { threadId: 3 },
        { threadId: "chat-a", toolCallId: "call-1", status: "stopped", sentence: stopped.sentence },
      ]),
    );
    expect(stopRememberedFor("chat-a", "call-1")).toEqual(stopped);
    error.mockRestore();
  });
});

describe("which stop a card shows", () => {
  const remembered: StopOutcome = { status: "stopped", sentence: "Stopped background job bg_1." };

  test("a stop that arrived on this page always wins over the record", () => {
    const live: StopOutcome = { status: "finished", sentence: "Already finished." };

    expect(resolveStopOutcome(live, true, () => remembered)).toEqual(live);
  });

  test("a job the transcript still shows as running takes the remembered stop after a reload", () => {
    expect(resolveStopOutcome(undefined, true, () => remembered)).toEqual(remembered);
  });

  test("a job the transcript shows as finished or ended keeps its own reading", () => {
    expect(resolveStopOutcome(undefined, false, () => remembered)).toBeUndefined();
  });

  test("the record is not read at all when a stop on this page already decides the card", () => {
    let reads = 0;

    resolveStopOutcome(stopped, true, () => {
      reads += 1;
      return remembered;
    });

    expect(reads).toBe(0);
  });
});
