import { describe, expect, test } from "vitest";
import {
  type CodeLanguage,
  fileLanguageLabel,
  loadCodeLanguage,
  resolveCodeLanguage,
} from "../../markdown/code-language";

/** Every language, as a record: adding a language to the module fails to typecheck until it is listed here. */
const EVERY_LANGUAGE: Record<CodeLanguage, true> = {
  bash: true,
  c: true,
  cpp: true,
  csharp: true,
  css: true,
  diff: true,
  dockerfile: true,
  go: true,
  html: true,
  ini: true,
  java: true,
  javascript: true,
  jsx: true,
  json: true,
  jsonc: true,
  kotlin: true,
  lua: true,
  markdown: true,
  php: true,
  python: true,
  ruby: true,
  rust: true,
  scss: true,
  sql: true,
  swift: true,
  toml: true,
  tsx: true,
  typescript: true,
  xml: true,
  yaml: true,
};

describe("code language resolution", () => {
  test("a fence name or a file extension names its language, in any case", () => {
    expect(resolveCodeLanguage("ts")).toBe("typescript");
    expect(resolveCodeLanguage("TSX")).toBe("tsx");
    expect(resolveCodeLanguage("  python ")).toBe("python");
    expect(resolveCodeLanguage("shell")).toBe("bash");
    expect(resolveCodeLanguage("c++")).toBe("cpp");
    expect(resolveCodeLanguage("svg")).toBe("xml");
  });

  test("an unknown or missing name is plain text", () => {
    for (const name of [undefined, "", "text", "plain", "nonsense", "txt"]) {
      expect(resolveCodeLanguage(name)).toBeUndefined();
    }
  });

  test("a file's label names its language, and the label resolves back to it", () => {
    expect(fileLanguageLabel("src/app.ts")).toBe("typescript");
    expect(resolveCodeLanguage(fileLanguageLabel("src/app.ts"))).toBe("typescript");
    expect(fileLanguageLabel("src/App.TSX?raw=1")).toBe("tsx");
    expect(fileLanguageLabel("C:\\work\\run.py")).toBe("python");
    expect(resolveCodeLanguage(fileLanguageLabel("tools/deploy", "#!/bin/sh\n"))).toBe("bash");
  });

  test("a file with no known language keeps its extension, or reads as text", () => {
    expect(fileLanguageLabel("notes/readme.txt")).toBe("txt");
    expect(resolveCodeLanguage(fileLanguageLabel("notes/readme.txt"))).toBeUndefined();
    expect(fileLanguageLabel("tools/deploy")).toBe("text");
    expect(fileLanguageLabel(".bashrc")).toBe("text");
  });

  test("a read's line selector is not part of the file name, so the label still names the language", () => {
    expect(fileLanguageLabel("src/gaps.ts:10-11,14-15")).toBe("typescript");
    expect(fileLanguageLabel("src/app.ts:raw")).toBe("typescript");
    expect(fileLanguageLabel("src/app.ts:50+20")).toBe("typescript");
    expect(fileLanguageLabel("src/app.ts:-20")).toBe("typescript");
    expect(fileLanguageLabel("lib/util.py:12")).toBe("python");
    expect(fileLanguageLabel("C:\\work\\run.py:3-9")).toBe("python");
    expect(fileLanguageLabel("notes/readme.txt:4")).toBe("txt");
  });

  test("every language has a grammar that loads", async () => {
    for (const language of Object.keys(EVERY_LANGUAGE) as CodeLanguage[]) {
      const registrations = await loadCodeLanguage(language);
      expect(registrations.length, language).toBeGreaterThan(0);
    }
  }, 120_000);
});
