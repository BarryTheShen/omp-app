import { describe, expect, test } from "vitest";
import { parseFileList, summaryWithFileLists } from "./summary-file-lists";

// omp's real shape: its preamble, the model's text, a blank line, then the block
// (branch-summarization.ts:371-375, utils.ts:191-202, prompts/file-operations.md).
const OMP_SUMMARY = [
  "User explored another conversation branch, then returned here.",
  "Exploration summary:",
  "",
  "## Goal",
  "Keep the parser stable.",
  "",
  "<files>",
  "# src/",
  "parser.ts (Read)",
  "store.ts (RW)",
  "# src/lib/",
  "hash.ts (Write)",
  "</files>",
].join("\n");

describe("summaryWithFileLists", () => {
  test("turns omp's real shape into two plain lists and keeps the model's text", () => {
    expect(summaryWithFileLists(OMP_SUMMARY)).toBe(
      [
        "User explored another conversation branch, then returned here.",
        "Exploration summary:",
        "",
        "## Goal",
        "Keep the parser stable.",
        "",
        "**Files read**",
        "",
        "- `src/parser.ts`",
        "",
        "**Files changed**",
        "",
        "- `src/store.ts`",
        "- `src/lib/hash.ts`",
      ].join("\n"),
    );
  });

  test("leaves no raw file tag or directory header in the text", () => {
    const rewritten = summaryWithFileLists(OMP_SUMMARY);
    expect(rewritten).not.toContain("<files>");
    expect(rewritten).not.toContain("</files>");
    expect(rewritten).not.toContain("# src/");
  });

  test("lists a file read and then changed (RW) under Files changed only", () => {
    const rewritten = summaryWithFileLists("<files>\n# src/\nstore.ts (RW)\n</files>");
    expect(rewritten).toBe("**Files changed**\n\n- `src/store.ts`");
  });

  test("says how many files omp left out of the block", () => {
    const rewritten = summaryWithFileLists("<files>\na.ts (Read)\n[…5 files elided…]\n</files>");
    expect(rewritten).toBe("**Files read**\n\n- `a.ts`\n\n5 more files not listed.");
  });

  test("keeps a file before any directory header at the root", () => {
    expect(parseFileList("README.md (Read)\n# src/\nx.ts (Write)")).toEqual({
      read: ["README.md"],
      changed: ["src/x.ts"],
      elided: 0,
    });
  });

  test("reads omp's nested path tree: each level adds one #, and a folded chain is one header", () => {
    // omp's `formatGroupedPaths` (packages/utils/src/path-tree.ts): a directory with files of its own keeps
    // them bare under its header, its subdirectories follow with one more `#`, and a chain of
    // single-child directories folds into one header.
    const block = [
      "top.md (Read)",
      "# src/",
      "parser.ts (Read)",
      "store.ts (RW)",
      "## lib/",
      "hash.ts (Write)",
      "### deep/nest/",
      "x.ts (Read)",
      "## other/",
      "y.ts (Read)",
      "# a/b/c/",
      "z.ts (Write)",
    ].join("\n");
    expect(parseFileList(block)).toEqual({
      read: ["top.md", "src/parser.ts", "src/lib/deep/nest/x.ts", "src/other/y.ts"],
      changed: ["src/store.ts", "src/lib/hash.ts", "a/b/c/z.ts"],
      elided: 0,
    });
  });

  test("quotes a file name that holds a backtick so it stays one code span", () => {
    expect(summaryWithFileLists("<files>\n# docs/\nnotes`1.md (Read)\n</files>")).toBe(
      "**Files read**\n\n- ``docs/notes`1.md``",
    );
  });

  test("a block that lists no files leaves no empty heading", () => {
    expect(summaryWithFileLists("Before.\n\n<files>\n</files>").trim()).toBe("Before.");
  });

  test("text without a files block is unchanged", () => {
    const plain = "## Goal\n\n- Keep the parser stable.";
    expect(summaryWithFileLists(plain)).toBe(plain);
  });
});
