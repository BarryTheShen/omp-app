import { describe, expect, test } from "vitest";
import { withRestored } from "./restored";

describe("text coming back to the message box", () => {
  test("goes in front of what the box holds, and not again when the box already holds it as whole paragraphs", () => {
    expect(withRestored(["fix the build"], "and run the tests")).toBe(
      "fix the build\n\nand run the tests",
    );
    expect(withRestored(["fix the build"], "fix the build")).toBe("fix the build");
    expect(withRestored(["fix the build"], "fix the build\n\nand run the tests")).toBe(
      "fix the build\n\nand run the tests",
    );
    expect(withRestored(["two\n\nparagraphs"], "first\n\ntwo\n\nparagraphs")).toBe(
      "first\n\ntwo\n\nparagraphs",
    );
  });

  test("text that only contains the restored words is not taken for it", () => {
    expect(withRestored(["yes"], "yes, do it")).toBe("yes\n\nyes, do it");
    expect(withRestored(["a", "b"], "")).toBe("a\n\nb");
  });
});
