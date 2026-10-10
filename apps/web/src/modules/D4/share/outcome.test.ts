import { describe, expect, test } from "vitest";
import { describeShareOutcome } from "./outcome";

const LINK = { url: "https://my.omp.sh/s/abc1234567#key", truncated: false };

describe("the share outcome sentence", () => {
  test("each outcome says what happened, in one plain sentence", () => {
    expect(describeShareOutcome({ outcome: "copied", result: LINK })).toBe(
      "Share link copied. Anyone with the link can read this chat.",
    );
    expect(describeShareOutcome({ outcome: "shown-for-manual-copy", result: LINK })).toBe(
      "Share link shown so you can copy it by hand.",
    );
    expect(describeShareOutcome({ outcome: "link-not-copied", result: LINK })).toBe(
      "Share link made, but not copied. Share again to make a new link.",
    );
    expect(describeShareOutcome({ outcome: "not-shared" })).toBe("Nothing was shared.");
  });

  test("a failure shows omp's own words, and never reads as copied", () => {
    const sentence = describeShareOutcome({
      outcome: "failed",
      error: {
        code: "unavailable",
        message: "omp could not share this chat. Try again in a moment.",
        retryable: true,
      },
    });
    expect(sentence).toBe("omp could not share this chat. Try again in a moment.");
    expect(sentence).not.toMatch(/copied/);
  });
});
