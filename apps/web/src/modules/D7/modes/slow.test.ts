import { describe, expect, test } from "vitest";
import type { UsageLimitStage } from "../contract";
import { usageLimitText } from "./slow";

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });

// A fixed "now", and reset times on the same day and on another day, so every expected sentence is exact.
const now = new Date(2026, 9, 11, 9, 0, 0);
const sameDay = new Date(2026, 9, 11, 14, 30, 0);
const otherDay = new Date(2026, 9, 14, 14, 30, 0);
const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

describe("the plain sentence for omp's usage-limit stage", () => {
  test("low priority says when the limit resets, and how much of the allowance is left", () => {
    const stage: UsageLimitStage = {
      stage: "low_priority",
      resetsAtSec: seconds(sameDay),
      allowanceLeftPercent: 62,
    };
    expect(usageLimitText(stage, now)).toBe(
      `Requests run at low priority until your limit resets at ${clock.format(sameDay)}. 62% of the low-priority allowance is left.`,
    );
  });

  test("low priority without an allowance report ends with the reset time", () => {
    const stage: UsageLimitStage = { stage: "low_priority", resetsAtSec: seconds(sameDay) };
    expect(usageLimitText(stage, now)).toBe(
      `Requests run at low priority until your limit resets at ${clock.format(sameDay)}.`,
    );
  });

  test("low priority on another day names the weekday of the reset", () => {
    const stage: UsageLimitStage = { stage: "low_priority", resetsAtSec: seconds(otherDay) };
    expect(usageLimitText(stage, now)).toBe(
      `Requests run at low priority until your limit resets on ${weekday.format(otherDay)} at ${clock.format(otherDay)}.`,
    );
  });

  test("wrap-up without extra usage waits for the limit, and says when it resets", () => {
    const stage: UsageLimitStage = {
      stage: "wrap_up",
      extraUsage: false,
      resetsAtSec: seconds(sameDay),
    };
    expect(usageLimitText(stage, now)).toBe(
      `Your usage limit is reached. Requests get a short wrap-up allowance, then wait until your limit resets at ${clock.format(sameDay)}.`,
    );
  });

  test("wrap-up without a reset time says the limit resets, with no time made up", () => {
    const stage: UsageLimitStage = { stage: "wrap_up", extraUsage: false };
    expect(usageLimitText(stage, now)).toBe(
      "Your usage limit is reached. Requests get a short wrap-up allowance, then wait until your limit resets.",
    );
  });

  test("wrap-up with extra usage says paid extra usage serves requests, then when the limit resets", () => {
    const stage: UsageLimitStage = {
      stage: "wrap_up",
      extraUsage: true,
      resetsAtSec: seconds(sameDay),
    };
    expect(usageLimitText(stage, now)).toBe(
      `Your usage limit is reached. Requests get a short wrap-up allowance, then paid extra usage serves them. Your limit resets at ${clock.format(sameDay)}.`,
    );
  });

  test("no sentence carries omp's internal words", () => {
    const internal =
      /RPC|gateway|capabilit|fallback|baseline|tier|command|prelude|slash|session|conversation|typed|probe|policy|detail|configured|flex|execution-mode|standard path|\/[a-z]/i;
    const stages: UsageLimitStage[] = [
      { stage: "low_priority", resetsAtSec: seconds(otherDay), allowanceLeftPercent: 5 },
      { stage: "wrap_up", extraUsage: true, resetsAtSec: seconds(sameDay) },
      { stage: "wrap_up", extraUsage: false },
    ];
    for (const stage of stages) {
      expect(usageLimitText(stage, now)).not.toMatch(internal);
    }
  });
});
