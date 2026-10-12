import { describe, expect, test } from "bun:test";
import { sessionDisplayTitle } from "./title-card";

describe("sessionDisplayTitle", () => {
  test("an emoji card shows the title's own words", () => {
    expect(sessionDisplayTitle("🧪 FLAKY: Fix flaky park tests")).toBe("Fix flaky park tests");
  });

  test("a Nerd Font glyph, a private-use character, is dropped the same way", () => {
    expect(sessionDisplayTitle("\uF0C3 FLAKY: Fix flaky park tests")).toBe("Fix flaky park tests");
  });

  test("a multi-character emoji icon is one icon", () => {
    expect(sessionDisplayTitle("👩‍🔬 LAB: Run the samples")).toBe("Run the samples");
  });

  test("the title keeps its own colons", () => {
    expect(sessionDisplayTitle("🧪 FLAKY: Fix: the park tests")).toBe("Fix: the park tests");
  });

  test("a plain title comes back unchanged, including one with a colon", () => {
    expect(sessionDisplayTitle("Fix flaky park tests")).toBe("Fix flaky park tests");
    expect(sessionDisplayTitle("Fix: the parser")).toBe("Fix: the parser");
  });

  test("an ASCII word before a code is not an icon", () => {
    expect(sessionDisplayTitle("A FLAKY: Fix flaky park tests")).toBe(
      "A FLAKY: Fix flaky park tests",
    );
  });

  test("an icon longer than omp's limit of 8 characters is not an icon", () => {
    expect(sessionDisplayTitle("🧪🧪🧪🧪🧪🧪🧪🧪🧪 FLAKY: Fix")).toBe(
      "🧪🧪🧪🧪🧪🧪🧪🧪🧪 FLAKY: Fix",
    );
  });

  test("a lowercase code is not a card, as in omp's form", () => {
    expect(sessionDisplayTitle("🧪 flaky: Fix flaky park tests")).toBe(
      "🧪 flaky: Fix flaky park tests",
    );
  });

  test("a card with no title after its code is not a card", () => {
    expect(sessionDisplayTitle("🧪 FLAKY: ")).toBe("🧪 FLAKY: ");
  });
});
