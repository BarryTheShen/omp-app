import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { CANCEL_REFUSED_MESSAGE } from "@/modules/P1/panels/model";
import { nestedCancelControl } from "../use-nested-cancel";
import { agentRef } from "./fixtures";

const running = agentRef();
const finished = agentRef({ status: "completed" });
const notFound = new AppFailure({ code: "not_found", message: "gone", retryable: false });
const failedAt = (error: AppFailure) => ({ state: "failed" as const, error: error.appError });

describe("the nested cancel control", () => {
  test("a running worker can be cancelled, and a press shows the sending and sent phases", () => {
    expect(nestedCancelControl(running, undefined)).toEqual({ state: "ready" });
    expect(nestedCancelControl(running, { state: "sending" })).toEqual({ state: "sending" });
    expect(nestedCancelControl(running, { state: "sent" })).toEqual({ state: "sent" });
  });

  test("omp's refusal keeps the worker running, with the words that say so", () => {
    expect(nestedCancelControl(running, { state: "refused" })).toEqual({
      state: "refused",
      message: CANCEL_REFUSED_MESSAGE,
    });
  });

  test("a failed cancel shows plain words and offers a retry only when the error is retryable", () => {
    const control = nestedCancelControl(running, failedAt(notFound));
    expect(control).toMatchObject({ state: "failed", retryable: false });
  });

  test("a finished worker shows no control, unless omp's answer explains that it had ended", () => {
    expect(nestedCancelControl(finished, undefined)).toEqual({ state: "hidden" });
    expect(nestedCancelControl(finished, { state: "sent" })).toEqual({ state: "hidden" });
    expect(nestedCancelControl(finished, failedAt(notFound))).toMatchObject({ state: "ended" });
  });
});
