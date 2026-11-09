import { describe, expect, test } from "vitest";
import {
  editedText,
  insideRealRoot,
  KeptOutput,
  matchLines,
  numberedLines,
  OUTPUT_HEAD,
  OUTPUT_TAIL,
  projectPath,
  READ_MAX_LINES,
  searchPattern,
} from "./rules";

const ROOT = "/work/app";

describe("which path a call names", () => {
  test("a path relative to the folder, or an absolute one inside it", () => {
    expect(projectPath(ROOT, "src/a.ts")).toEqual({
      absolute: "/work/app/src/a.ts",
      relative: "src/a.ts",
    });
    expect(projectPath(ROOT, "./src//b.ts")).toEqual({
      absolute: "/work/app/src/b.ts",
      relative: "src/b.ts",
    });
    expect(projectPath(ROOT, "/work/app/c.ts").relative).toBe("c.ts");
    expect(projectPath(ROOT, "src/../d.ts").relative).toBe("d.ts");
    expect(projectPath(ROOT, ".").relative).toBe(".");
  });

  test("anything outside the folder is refused, also by .. or an absolute path elsewhere; an empty path asks which", () => {
    for (const outside of ["../secret", "src/../../x", "/etc/passwd", "/work/application/x"])
      expect(() => projectPath(ROOT, outside)).toThrow("outside the project's folder");
    expect(() => projectPath(ROOT, "  ")).toThrow("Say which file");
    expect(() => projectPath(ROOT, 7)).toThrow("Say which file");
  });

  test("a link that leads out of the folder is out", () => {
    expect(insideRealRoot("/real/app", "/real/app/src/a.ts")).toBe(true);
    expect(insideRealRoot("/real/app", "/real/app")).toBe(true);
    expect(insideRealRoot("/real/app", "/real/elsewhere/a.ts")).toBe(false);
    expect(insideRealRoot("/real/app", "/real/app-2/a.ts")).toBe(false);
  });
});

describe("an edit", () => {
  const text = "const a = 1;\nconst b = 2;\nconst a2 = 1;\n";

  test("replaces text that occurs once; every time with replace_all", () => {
    expect(editedText(text, "const b = 2;", "const b = 3;", false, "x.ts")).toBe(
      "const a = 1;\nconst b = 3;\nconst a2 = 1;\n",
    );
    expect(editedText(text, "= 1;", "= 9;", true, "x.ts")).toBe(
      "const a = 9;\nconst b = 2;\nconst a2 = 9;\n",
    );
    // `$` in the new text is taken as it is.
    expect(editedText("x", "x", "$&$1", false, "x.ts")).toBe("$&$1");
  });

  test("is refused, with what to do, when the text is not there, occurs more than once, is empty or changes nothing", () => {
    expect(() => editedText(text, "const c", "x", false, "x.ts")).toThrow(
      "old_text is not in x.ts",
    );
    expect(() => editedText(text, "= 1;", "= 9;", false, "x.ts")).toThrow("occurs 2 times in x.ts");
    expect(() => editedText(text, "", "x", false, "x.ts")).toThrow("old_text is empty");
    expect(() => editedText(text, "const b", "const b", false, "x.ts")).toThrow(
      "nothing would change",
    );
  });
});

describe("what a read, a search and a command give back", () => {
  test("numbered lines, a range of them, and where to read on in a long file", () => {
    expect(numberedLines("a\nb\nc\n")).toBe("1\ta\n2\tb\n3\tc");
    expect(numberedLines("a\nb\nc\n", 2, 2)).toBe(
      "2\tb\n(Lines 2-2 of 3; ask for start_line 3 to read on.)",
    );
    expect(numberedLines("")).toBe("(The file is empty.)");
    const long = `${Array.from({ length: READ_MAX_LINES + 10 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    expect(numberedLines(long).split("\n").at(-1)).toBe(
      `(Lines 1-${READ_MAX_LINES} of ${READ_MAX_LINES + 10}; ask for start_line ${READ_MAX_LINES + 1} to read on.)`,
    );
    expect(() => numberedLines("a\nb\n", 2, 1)).toThrow("comes before");
  });

  test("a search's matches as path:line: text; plain text is taken as it is; a bad pattern says so", () => {
    const pattern = searchPattern("TODO\\(", false, false);
    expect(matchLines("src/a.ts", "x\n  // todo(fix)\nTODO(y)\n", pattern, 10)).toEqual([
      "src/a.ts:2: // todo(fix)",
      "src/a.ts:3: TODO(y)",
    ]);
    expect(matchLines("a", "a.b\naxb\n", searchPattern("a.b", true, true), 10)).toEqual([
      "a:1: a.b",
    ]);
    expect(matchLines("a", "x\nx\nx\n", searchPattern("x", false, true), 2)).toHaveLength(2);
    expect(() => searchPattern("(", false, false)).toThrow("set literal for plain text");
  });

  test("a long command output, as it streams in pieces, keeps its start and its end and says what was cut", () => {
    const short = new KeptOutput();
    short.add("one\n");
    short.add("two\n");
    expect(short.text()).toBe("one\ntwo\n");

    const long = new KeptOutput();
    // Pieces that straddle where the start ends, as a pipe delivers them.
    for (const piece of [
      "a".repeat(OUTPUT_HEAD - 3),
      "aaabbb",
      "b".repeat(497),
      "c".repeat(OUTPUT_TAIL),
    ])
      long.add(piece);
    const text = long.text();
    expect(text.startsWith(`${"a".repeat(OUTPUT_HEAD)}\n… (500 characters cut) …\n`)).toBe(true);
    expect(text.endsWith(`\n${"c".repeat(OUTPUT_TAIL)}`)).toBe(true);

    // Exactly at the limits: nothing cut, nothing said.
    const full = new KeptOutput();
    full.add("x".repeat(OUTPUT_HEAD + OUTPUT_TAIL));
    expect(full.text()).toBe("x".repeat(OUTPUT_HEAD + OUTPUT_TAIL));
  });
});
