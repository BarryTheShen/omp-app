import { describe, expect, test } from "vitest";
import { D6_DESCRIPTORS } from "../descriptors";
import { D6_FALLBACK_FIXTURES } from "../fixtures";
import { D6_REPORT_PALETTE_COMMANDS } from "../reports";

const ALL_DESCRIPTORS = [...D6_REPORT_PALETTE_COMMANDS, ...D6_DESCRIPTORS];
const INTERNAL_COPY =
  /\b(?:RPC|JSONL|module|descriptor|capability|upstream|D6|C1|C3|TTSR|lifecycle|typed|host|authoritative|gate)\b|omp\.cmd/i;
const UPPERCASE_OMP = /\bOMP\b/;
const MUTATION_WORDS = ["lifecycle", "typed", "host", "authoritative", "gate"] as const;

function copyProblems(text: string): readonly string[] {
  const problems: string[] = [];
  if (INTERNAL_COPY.test(text)) problems.push("internal copy");
  if (UPPERCASE_OMP.test(text)) problems.push("uppercase OMP");
  return problems;
}

describe("CC4: D6 descriptor and fallback copy stays plain and consistent", () => {
  test("combined descriptor titles are distinct, readable and free of internal names", () => {
    const titles = ALL_DESCRIPTORS.map((descriptor) => descriptor.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const title of titles) {
      expect(title.trim()).not.toBe("");
      expect(copyProblems(title)).toEqual([]);
    }
  });

  test("fallback fixture titles and all reason/limitation strings read plainly", () => {
    expect(new Set(D6_FALLBACK_FIXTURES.map((fixture) => fixture.title)).size).toBe(
      D6_FALLBACK_FIXTURES.length,
    );
    for (const fixture of D6_FALLBACK_FIXTURES) {
      for (const text of [fixture.title, fixture.reason, ...fixture.limitations]) {
        expect(text.trim()).not.toBe("");
        expect(copyProblems(text)).toEqual([]);
      }
    }
  });

  test("the copy guard catches each mutated internal word in real fixture copy", () => {
    for (const word of MUTATION_WORDS) {
      const fixture = D6_FALLBACK_FIXTURES[0];
      if (!fixture) throw new Error("D6 fallback fixtures must not be empty");
      const mutated = `${fixture.reason} ${word}`;
      expect(copyProblems(mutated)).toContain("internal copy");
    }
    expect(copyProblems(`${D6_FALLBACK_FIXTURES[0]?.reason ?? ""} OMP`)).toContain("uppercase OMP");
  });

  test("descriptor and fixture data contain no literal styling", () => {
    const text = JSON.stringify({ descriptors: ALL_DESCRIPTORS, fixtures: D6_FALLBACK_FIXTURES });
    expect(text).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i);
  });
});
