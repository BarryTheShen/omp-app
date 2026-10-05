import { describe, expect, test } from "vitest";
import type { TodoPhase } from "../contract";
import { copyTodosMarkdown, exportTodosMarkdown, importTodosMarkdown } from "./markdown";

const phases: TodoPhase[] = [
  {
    name: "Build",
    tasks: [
      { content: "write tests", status: "pending" },
      { content: "ship", status: "completed" },
    ],
  },
  { name: "Review", tasks: [{ content: "approve", status: "abandoned" }] },
];

describe("todo Markdown", () => {
  test("round-trips phase headings and pending/completed checklist rows", () => {
    const markdown = exportTodosMarkdown(phases);
    expect(markdown).toContain("## Build");
    expect(markdown).toContain("- [ ] write tests");
    expect(markdown).toContain("- [x] ship");
    expect(importTodosMarkdown(markdown)).toEqual([
      {
        name: "Build",
        tasks: [
          { content: "write tests", status: "pending" },
          { content: "ship", status: "completed" },
        ],
      },
      { name: "Review", tasks: [{ content: "approve", status: "completed" }] },
    ]);
    expect(copyTodosMarkdown(phases)).toBe(markdown);
  });

  test("rejects malformed syntax and tasks without a phase", () => {
    expect(() => importTodosMarkdown("- [ ] orphan")).toThrowError(/before a phase heading/);
    expect(() => importTodosMarkdown("## Build\n- [?] invalid")).toThrowError(/Unsupported/);
  });
});
