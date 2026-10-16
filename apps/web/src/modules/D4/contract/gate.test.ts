/// <reference types="node" />
/**
 * D4's module gate. It reads D4's own source (not its tests) and proves the boundaries that copy, export, share and
 * import must keep: typed-port-only browser access (W5), no session file or JSONL in browser state (H1), token-only
 * styling (H4), U4-owned dialogs, and composer focus restored by U4 from an injected callback. Any matching source line
 * fails its rule; there are no exceptions. The last test maps each proof of Plan item 7 to the test files that prove it
 * and fails when one of those files goes missing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const D4_ROOT = join(process.cwd(), "src", "modules", "D4");

interface Rule {
  readonly id: string;
  /** The rule in plain words, as the failure message shows it. */
  readonly rule: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    id: "typed-ports",
    rule: "D4 accesses the browser, network and storage only through injected ports",
    pattern:
      /\b(?:document|window|navigator|localStorage|sessionStorage)\.|\bfetch\(|\bXMLHttpRequest\b|\bnew WebSocket\(|\bnew EventSource\(/,
  },
  {
    id: "no-session-files",
    rule: "D4 never names omp's session file or a .jsonl file, so no chat file reaches the browser",
    pattern: /\bsessionFile\b|\.jsonl\b/,
  },
  {
    id: "tokens-only",
    rule: "D4 writes no colour literal: colours come from the design tokens (H4)",
    pattern: /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/,
  },
  {
    id: "dialogs-through-host",
    rule: "D4 opens no dialog of its own: every picker, question and recovery goes through U4's DialogHost",
    pattern: /from\s+["'](?:@\/components\/ui\/(?:alert-)?dialog|@radix-ui\/react-dialog)["']/,
  },
  {
    id: "focus-restoration",
    rule: "D4 restores composer focus through U4, never with a direct focus call",
    pattern: /\.focus\(/,
  },
];

/** The D4 source files the gate reads: not tests, not the dev playground pages, not fixtures. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "fixtures") sourceFiles(full, out);
      continue;
    }
    if (/\.test\.tsx?$/.test(entry) || /^playground\.tsx$/.test(entry)) continue;
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** A line that is only a comment cannot reach the browser, so the gate reads code lines only. */
function isCommentLine(line: string): boolean {
  const text = line.trim();
  return text.startsWith("//") || text.startsWith("*") || text.startsWith("/*");
}

interface Match {
  readonly file: string;
  readonly line: string;
}

const FILES = sourceFiles(D4_ROOT).map((file) => relative(D4_ROOT, file));

/** Every code line of D4 that matches a boundary rule is a violation. */
function violationsOf(rule: Rule): Match[] {
  const violations: Match[] = [];
  for (const file of FILES) {
    const lines = readFileSync(join(D4_ROOT, file), "utf8").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (isCommentLine(line) || !rule.pattern.test(line)) continue;
      violations.push({ file, line });
    }
  }
  return violations;
}

/** Plan item 7's proofs, each with the test files that prove it. A proof whose file is gone fails here. */
const PROOFS: readonly { readonly proof: string; readonly files: readonly string[] }[] = [
  {
    proof: "raw Markdown and code copy, the copy picker and the clipboard refusal",
    files: [
      "copy/fences.test.ts",
      "copy/math-source.test.ts",
      "copy/actions.test.ts",
      "copy/picker.test.ts",
    ],
  },
  {
    proof: "export content and path, the terminal-only /open and /record states",
    files: [
      "export/format.test.ts",
      "export/port.test.ts",
      "export/whole-chat.test.ts",
      "export/commands.test.ts",
    ],
  },
  {
    proof:
      "typed /dump and /share results from A1's parsers, and a typed failure on any other shape",
    files: ["share/port.test.ts", "export/port.test.ts"],
  },
  {
    proof: "no share visibility or revoke control, and the upstream gate for visibility",
    files: ["share/visibility.test.ts", "contract/index.test.ts"],
  },
  {
    proof: "the import lifecycle: a new local chat, the shared chat left alone, the upstream gate",
    files: ["fork/controller.test.ts", "fork/port.test.ts", "fork/outcome.test.ts"],
  },
  {
    proof: "a question before every share or import, cancelled or declined means nothing sent",
    files: ["share/controller.test.ts", "share/confirm.test.ts", "fork/controller.test.ts"],
  },
  {
    proof:
      "descriptor coverage: each of the eight D5 rows D4 mounts, once; the six D4 slash names mounted, each once",
    files: [
      "descriptors/descriptors.test.ts",
      "export/descriptors.test.ts",
      "share/descriptors.test.ts",
      "fork/descriptors.test.ts",
    ],
  },
];

describe("D4's module gate", () => {
  test("reads D4's source, not an empty folder: the four parts are in the scan", () => {
    expect(FILES.length).toBeGreaterThan(30);
    for (const part of ["copy/", "export/", "share/", "fork/"]) {
      expect(FILES.some((file) => file.startsWith(part))).toBe(true);
    }
  });

  for (const rule of RULES) {
    test(`${rule.rule}`, () => {
      expect(violationsOf(rule)).toEqual([]);
    });
  }
  test("every proof of Plan item 7 has the test files that prove it", () => {
    const missing = PROOFS.flatMap(({ proof, files }) =>
      files.filter((file) => !existsSync(join(D4_ROOT, file))).map((file) => `${proof}: ${file}`),
    );
    expect(missing).toEqual([]);
  });
});
