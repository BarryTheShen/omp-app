import { describe, expect, test } from "vitest";
import type { RawTranscriptPart } from "@/modules/U1/model";
import { exactMarkdownOf } from "./text";

describe("copying a reply with math (issue #1167)", () => {
  test("copies the source the model wrote, dollar signs and all, not the typeset formulas", () => {
    const source = "Energy $E = KE + V$ and \\(a+b\\), costs $5 and $10.";
    const parts: RawTranscriptPart[] = [{ index: 0, type: "text", source: null, markdown: source }];
    expect(exactMarkdownOf(parts)).toBe(source);
  });
});
