/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { D8_DESCRIPTORS } from "../descriptors";
import { LOOP_UNAVAILABLE_REASON } from "../loop/gate";

/** The D8 folder. Vitest runs from apps/web, as the other gate tests assume. */
const D8_DIR = resolve(process.cwd(), "src/modules/D8");

/** Internal names a person should never read: ids, capability keys, jargon, and "OMP" or "Omp" for "omp". */
const INTERNAL_NAME =
  /\b(RPC|CAS|ConfigStore|typed|seam|descriptor|capability|module|upstream|D8|C3|AP\d+)\b|omp\.cmd|\bOMP\b|\bOmp\b/;
const D8_FEATURE_JARGON = /\b(?:tan|vibe)\b|hill-climb/i;

/** The four D8 surfaces. Each takes its cards, rows and empty states from the shared blocks. */
const VIEWS = ["goal/view.tsx", "guided/view.tsx", "loop/view.tsx", "workers/view.tsx"];

/** A shared building block drawn as an element. An import of a block does not draw it. */
const SHARED_BLOCK_ELEMENT = /<(Panel|Section|ListRow|EmptyState|InlineError|SettingRow|Toolbar)\b/;

/** Each view's source, read once. */
const viewSource: Readonly<Record<string, string>> = Object.fromEntries(
  VIEWS.map((view) => [view, readFileSync(resolve(D8_DIR, view), "utf8")]),
);

describe("CC4: D8 reads plainly and draws only from the design system", () => {
  test.each(D8_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.title]))(
    "%s has a plain English title",
    (_id, title) => {
      expect(title.trim()).not.toBe("");
      expect(title).not.toMatch(INTERNAL_NAME);
      expect(title).not.toMatch(D8_FEATURE_JARGON);
    },
  );
  test("descriptor titles are distinct", () => {
    const titles = D8_DESCRIPTORS.map((descriptor) => descriptor.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test("the loop's unavailable reason reads plainly", () => {
    expect(LOOP_UNAVAILABLE_REASON).not.toMatch(INTERNAL_NAME);
  });

  test("the workers panel uses plain names", () => {
    expect(viewSource["workers/view.tsx"]).not.toMatch(D8_FEATURE_JARGON);
  });
  test.each(VIEWS)("%s uses no literal colour, only design tokens", (view) => {
    expect(viewSource[view]).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\(/);
  });

  test.each(VIEWS)("%s renders a shared block", (view) => {
    expect(SHARED_BLOCK_ELEMENT.test(viewSource[view] ?? "")).toBe(true);
  });

  test("an import of a shared block alone does not count as rendering it", () => {
    expect(SHARED_BLOCK_ELEMENT.test('import { Section } from "@/components/blocks";')).toBe(false);
    expect(SHARED_BLOCK_ELEMENT.test('return <Section title="Goal">{text}</Section>;')).toBe(true);
  });
});
