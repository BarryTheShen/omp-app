import { describe, expect, test } from "vitest";
import type { PlanDocument } from "../contract";
import { planReviewChunks } from "./model";

const markdown = `# [Plan](https://safe.example)

## [Steps][guide]

Do the work. Reference: [guide][guide].

\`\`\`md
# Fenced heading
\`\`\`

Setext heading
--------------

[guide]: https://guide.example
`;

const planDocument: PlanDocument = {
  id: "plan",
  threadId: "thread-plan" as PlanDocument["threadId"],
  markdown,
  sections: [],
  annotations: [],
  status: "review",
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("P2 plan review model", () => {
  test("finds Markdown headings without A1 sections and keeps reference definitions across chunks", () => {
    const chunks = planReviewChunks(planDocument, "test");
    const headings = chunks.flatMap((chunk) => (chunk.heading === null ? [] : [chunk.heading]));

    expect(headings.map(({ text, level }) => ({ text, level }))).toEqual([
      { text: "Plan", level: 1 },
      { text: "Steps", level: 2 },
      { text: "Setext heading", level: 2 },
    ]);
    expect(new Set(headings.map(({ id }) => id)).size).toBe(3);
    expect(headings.every(({ id }) => id.startsWith("plan-review-test-"))).toBe(true);
    expect(chunks.find(({ heading }) => heading?.text === "Steps")?.markdown).toContain(
      "[guide]: https://guide.example",
    );
  });

  test("keeps every heading when one A1 section spans the whole document", () => {
    const document = {
      ...planDocument,
      sections: [{ id: "plans/complete", heading: "Plan", start: 0, end: 100 }],
    };
    const chunks = planReviewChunks(document, "test");
    const headings = chunks.flatMap((chunk) => (chunk.heading === null ? [] : [chunk.heading]));

    expect(headings.map(({ text }) => text)).toEqual(["Plan", "Steps", "Setext heading"]);
    expect(headings[0]?.sectionId).toBe("plans/complete");
    expect(headings[0]?.id).not.toContain("/");
    expect(headings.slice(1).every(({ sectionId }) => sectionId === undefined)).toBe(true);
  });

  test("gives repeated heading text its own anchor, so a jump lands on the right section", () => {
    const chunks = planReviewChunks(
      { ...planDocument, markdown: "# Notes\n\nfirst\n\n# Notes\n\nsecond\n", sections: [] },
      "test",
    );
    const ids = chunks.flatMap(({ heading }) => (heading === null ? [] : [heading.id]));

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
