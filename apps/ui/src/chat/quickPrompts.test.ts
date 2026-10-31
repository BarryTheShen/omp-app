import { describe, expect, test } from "vitest";
import { LONGEST_PROMPT, MOST_PROMPTS, promptsFrom } from "./quickPrompts";

describe("a phone's quick prompts, as typed one a line or as kept", () => {
  test("are trimmed, and empty lines, repeats and anything not text are dropped, in the order given", () => {
    expect(
      promptsFrom(["  Continue ", "", "Sure", "   ", "Continue", 7, null, "Go ahead"]),
    ).toEqual(["Continue", "Sure", "Go ahead"]);
  });

  test("keep at most the limit of prompts, each cut to the longest a prompt may be", () => {
    const many = Array.from({ length: MOST_PROMPTS + 5 }, (_, index) => `prompt ${index}`);
    const kept = promptsFrom(many);
    expect(kept).toHaveLength(MOST_PROMPTS);
    expect(kept.at(-1)).toBe(`prompt ${MOST_PROMPTS - 1}`);
    expect(promptsFrom(["x".repeat(LONGEST_PROMPT + 10)])[0]).toHaveLength(LONGEST_PROMPT);
  });
});
