import { describe, expect, test } from "vitest";
import { modeOutcomeRetryable, modeOutcomeText, type TypedModeOutcome } from "./outcomes";

describe("the plain sentence for each typed mode outcome", () => {
  test("an applied toggle says whether it is on or off, in the mode's own label", () => {
    expect(modeOutcomeText({ outcome: "applied", mode: "slow", on: true })).toBe(
      "Slow mode is on.",
    );
    expect(modeOutcomeText({ outcome: "applied", mode: "slow", on: false })).toBe(
      "Slow mode is off.",
    );
    expect(modeOutcomeText({ outcome: "applied", mode: "computer", on: true })).toBe(
      "Computer use is on.",
    );
    expect(modeOutcomeText({ outcome: "applied", mode: "extended-context", on: false })).toBe(
      "Extended context is off.",
    );
  });

  test("an applied browser window says which window it is set to, in the labels the buttons show", () => {
    expect(modeOutcomeText({ outcome: "applied", mode: "browser", visibility: "visible" })).toBe(
      "Browser use is set to Visible window.",
    );
    expect(modeOutcomeText({ outcome: "applied", mode: "browser", visibility: "headless" })).toBe(
      "Browser use is set to Headless.",
    );
  });

  test("each unsupported reason says the mode is not available here", () => {
    expect(
      modeOutcomeText({ outcome: "unsupported", mode: "slow", reason: "model-has-no-slow-mode" }),
    ).toBe("Slow mode is not available for this model.");
    expect(
      modeOutcomeText({ outcome: "unsupported", mode: "computer", reason: "not-in-session" }),
    ).toBe("Computer use is not available in this chat.");
    expect(
      modeOutcomeText({ outcome: "unsupported", mode: "extended-context", reason: "not-offered" }),
    ).toBe("omp does not offer this setting here.");
  });

  test("each refused reason says why the change did not take", () => {
    expect(
      modeOutcomeText({ outcome: "refused", mode: "slow", reason: "claude-usage-limit" }),
    ).toBe("Slow mode stayed off: the Claude usage limit has been reached.");
    expect(
      modeOutcomeText({ outcome: "refused", mode: "browser", reason: "browser-restart-failed" }),
    ).toBe("The browser could not restart in that window. Try again.");
  });

  test("none of the sentences carries omp's words or an internal name", () => {
    const outcomes: TypedModeOutcome[] = [
      { outcome: "applied", mode: "slow", on: true },
      { outcome: "applied", mode: "browser", visibility: "headless" },
      { outcome: "refused", mode: "slow", reason: "claude-usage-limit" },
      { outcome: "refused", mode: "browser", reason: "browser-restart-failed" },
      { outcome: "unsupported", mode: "slow", reason: "model-has-no-slow-mode" },
      { outcome: "unsupported", mode: "computer", reason: "not-in-session" },
      { outcome: "unsupported", mode: "extended-context", reason: "not-offered" },
    ];
    for (const outcome of outcomes) {
      expect(modeOutcomeText(outcome)).not.toMatch(
        /command|RPC|session|tier|prelude|slash|\/[a-z]/i,
      );
    }
  });
});

describe("whether a mode outcome can be tried again", () => {
  test("only a browser window that did not restart can be tried again as it is", () => {
    expect(
      modeOutcomeRetryable({
        outcome: "refused",
        mode: "browser",
        reason: "browser-restart-failed",
      }),
    ).toBe(true);
    expect(
      modeOutcomeRetryable({ outcome: "refused", mode: "slow", reason: "claude-usage-limit" }),
    ).toBe(false);
    expect(
      modeOutcomeRetryable({
        outcome: "unsupported",
        mode: "slow",
        reason: "model-has-no-slow-mode",
      }),
    ).toBe(false);
  });
});
