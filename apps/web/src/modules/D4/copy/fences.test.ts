import { describe, expect, test } from "vitest";
import { fencedBlocks, isShellLanguage } from "./fences";

describe("fencedBlocks", () => {
  test("returns each block's language and content without its fences", () => {
    expect(fencedBlocks("Intro\n```ts\nconst answer = 42;\n```\nOutro")).toEqual([
      { index: 0, language: "ts", content: "const answer = 42;" },
    ]);
  });

  test("keeps the lines between the fences exactly, and drops only the final line ending", () => {
    expect(fencedBlocks("```\nfirst\n\n  second\n```")).toEqual([
      { index: 0, language: "", content: "first\n\n  second" },
    ]);
  });

  test("accepts tilde fences, and a closing fence only with the same character", () => {
    expect(fencedBlocks("~~~\na\n```\nb\n~~~")).toEqual([
      { index: 0, language: "", content: "a\n```\nb" },
    ]);
  });

  test("needs a closing fence at least as long as the opening one", () => {
    expect(fencedBlocks("````\na\n```\n````")).toEqual([
      { index: 0, language: "", content: "a\n```" },
    ]);
    expect(fencedBlocks("````\na\n```\n")).toEqual([{ index: 0, language: "", content: "a\n```" }]);
  });

  test("removes at most the opening fence's indentation from each line", () => {
    expect(fencedBlocks("  ```js\n  x\n   y\n  ```")).toEqual([
      { index: 0, language: "js", content: "x\n y" },
    ]);
  });

  test("does not treat four-space indentation as a fence", () => {
    expect(fencedBlocks("    ```\n    x\n    ```")).toEqual([]);
  });

  test("does not treat a backtick line with a backtick in its info string as a fence", () => {
    expect(fencedBlocks("```a`b\nx")).toEqual([]);
  });

  test("runs an unclosed fence to the end of the text, as CommonMark does", () => {
    expect(fencedBlocks("```python\nprint(1)")).toEqual([
      { index: 0, language: "python", content: "print(1)" },
    ]);
  });

  test("numbers every block, empty ones included, and lowercases the language", () => {
    expect(fencedBlocks("```\n```\n```TS\nlet x = 1;\n```\n")).toEqual([
      { index: 0, language: "", content: "" },
      { index: 1, language: "ts", content: "let x = 1;" },
    ]);
  });

  test("reads CRLF line endings without keeping the carriage return", () => {
    expect(fencedBlocks("```\r\na\r\nb\r\n```\r\n")).toEqual([
      { index: 0, language: "", content: "a\r\nb" },
    ]);
  });
});

describe("isShellLanguage", () => {
  test("names shell languages, so their blocks copy as commands", () => {
    for (const language of ["bash", "sh", "shell", "zsh", "console", "shellsession"]) {
      expect(isShellLanguage(language)).toBe(true);
    }
  });

  test("does not name other languages, empty names, or prototype keys", () => {
    for (const language of ["ts", "python", "", "constructor"]) {
      expect(isShellLanguage(language)).toBe(false);
    }
  });
});
