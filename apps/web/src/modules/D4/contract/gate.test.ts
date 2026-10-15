/// <reference types="node" />
/**
 * D4.7's module gate. It reads D4's own source (not its tests) and proves the boundaries that copy, export, share and
 * import must keep: D4 reaches the browser only through typed ports (W5), keeps no session file or JSONL in browser
 * state (H1, Plan item 7), styles only with design tokens (H4, CC4), opens every dialog through U4's DialogHost, and
 * sets focus only where it is listed. Each rule has an allowlist of exact sites. An allowlisted site that no longer
 * exists fails the gate, so the list cannot go stale. The last test maps each proof of Plan item 7 to the test files
 * that prove it, and fails when one of those files goes missing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const D4_ROOT = join(process.cwd(), "src", "modules", "D4");

interface Allowed {
  /** The file, relative to D4's folder. */
  readonly file: string;
  /** The trimmed text of the one line that may match in that file. */
  readonly line: string;
}

interface Rule {
  readonly id: string;
  /** The rule in plain words, as the failure message shows it. */
  readonly rule: string;
  readonly pattern: RegExp;
  readonly allowed: readonly Allowed[];
}

/**
 * The composer focus after an import. It is the one place D4 reaches the page itself; moving it behind U4's
 * `restoreFocus` or an injected focus port is a follow-up for the D4.5 owner, and this entry must go with that change.
 */
const COMPOSER_FOCUS: Allowed = {
  file: "fork/use-import-from-share.ts",
  line: "if (settled > 0) document.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT)?.focus();",
};

const RULES: readonly Rule[] = [
  {
    id: "typed-ports",
    rule: "D4 reaches the browser, the network and storage only through typed ports, never through a browser global",
    pattern:
      /\b(?:document|window|navigator|localStorage|sessionStorage)\.|\bfetch\(|\bXMLHttpRequest\b|\bnew WebSocket\(|\bnew EventSource\(/,
    allowed: [COMPOSER_FOCUS],
  },
  {
    id: "no-session-files",
    rule: "D4 never names omp's session file or a .jsonl file, so no chat file reaches the browser",
    pattern: /\bsessionFile\b|\.jsonl\b/,
    allowed: [],
  },
  {
    id: "tokens-only",
    rule: "D4 writes no colour literal: colours come from the design tokens (H4)",
    pattern: /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/,
    allowed: [],
  },
  {
    id: "dialogs-through-host",
    rule: "D4 opens no dialog of its own: every picker, question and recovery goes through U4's DialogHost",
    pattern: /from\s+["'](?:@\/components\/ui\/(?:alert-)?dialog|@radix-ui\/react-dialog)["']/,
    allowed: [],
  },
  {
    id: "focus-only-listed",
    rule: "D4 moves focus only at the listed sites",
    pattern: /\.focus\(/,
    allowed: [COMPOSER_FOCUS],
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

/** Every code line of D4 that matches the rule and is not on the rule's allowlist. */
function violationsOf(rule: Rule): Match[] {
  const violations: Match[] = [];
  for (const file of FILES) {
    const lines = readFileSync(join(D4_ROOT, file), "utf8").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (isCommentLine(line) || !rule.pattern.test(line)) continue;
      const allowed = rule.allowed.some((entry) => entry.file === file && entry.line === line);
      if (!allowed) violations.push({ file, line });
    }
  }
  return violations;
}

/** The allowlisted sites that no longer match, so an entry for code that was removed cannot linger. */
function staleAllowances(rule: Rule): Allowed[] {
  return rule.allowed.filter(
    (entry) =>
      !FILES.includes(entry.file) ||
      !readFileSync(join(D4_ROOT, entry.file), "utf8")
        .split("\n")
        .some((raw) => raw.trim() === entry.line),
  );
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

    test(`the allowlist for "${rule.id}" has no entry for code that is gone`, () => {
      expect(staleAllowances(rule)).toEqual([]);
    });
  }

  test("every proof of Plan item 7 has the test files that prove it", () => {
    const missing = PROOFS.flatMap(({ proof, files }) =>
      files.filter((file) => !existsSync(join(D4_ROOT, file))).map((file) => `${proof}: ${file}`),
    );
    expect(missing).toEqual([]);
  });
});
