/// <reference types="node" />
/**
 * Enforces H4 / U0 Plan item 2: colors, radii and shadows come only from `src/styles/tokens.css`
 * and its typed mirror `src/tokens.ts`; everywhere else in `apps/web/src` must reference a token
 * (`var(--…)`, a token-backed Tailwind utility class, or one of `tokens.ts`'s exports), never a
 * hard-coded literal.
 *
 * `src/components/**` is excluded: those files are copied byte-for-byte from shadcn's and
 * assistant-ui's own component registries and are refreshed only by their CLI (the repo-wide
 * rule "anything copied or generated is refreshed by its script, never edited by hand",
 * `packages/contracts/README.md`). This test cannot enforce a convention on code this part may
 * not edit, and a future `npx assistant-ui upgrade` would just reintroduce any value it flagged.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");
const STYLES_DIR = join(SRC_ROOT, "styles");

const SCANNED_EXTENSIONS = [".ts", ".tsx", ".css"];
/** Directories, wherever they appear under `src`, that this test does not scan. */
const EXCLUDED_DIR_NAMES = new Set(["components", "styles"]);
const EXCLUDED_FILE_NAMES = new Set(["tokens.ts"]);

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry)) continue;
      collectFiles(full, out);
      continue;
    }
    if (EXCLUDED_FILE_NAMES.has(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  reason: string;
  snippet: string;
}

const CHECKS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /#[0-9a-fA-F]{3,8}\b/, reason: "hex color literal" },
  {
    pattern: /\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/,
    reason: "raw color function (use a color token instead)",
  },
  { pattern: /\[-?\d+(?:\.\d+)?px\]/, reason: "arbitrary Tailwind pixel value" },
  {
    pattern: /box-shadow\s*:\s*(?!var\()/i,
    reason: "raw CSS box-shadow (use a shadow token)",
  },
  {
    pattern: /boxShadow\s*:\s*["'`](?!var\()/,
    reason: "raw inline boxShadow (use a shadow token)",
  },
  {
    pattern: /border-radius\s*:\s*(?!var\()[0-9.]/i,
    reason: "raw CSS border-radius (use a radius token)",
  },
  {
    pattern: /borderRadius\s*:\s*["'`]?(?!var\()[0-9.]/,
    reason: "raw inline borderRadius (use a radius token)",
  },
];

function scan(file: string): Violation[] {
  const text = readFileSync(file, "utf-8");
  const violations: Violation[] = [];
  text.split("\n").forEach((line, index) => {
    for (const { pattern, reason } of CHECKS) {
      if (pattern.test(line)) {
        violations.push({
          file: relative(SRC_ROOT, file),
          line: index + 1,
          reason,
          snippet: line.trim(),
        });
      }
    }
  });
  return violations;
}

describe("design token boundary", () => {
  test("tokens.css is the file allowed to declare raw colors", () => {
    const text = readFileSync(join(STYLES_DIR, "tokens.css"), "utf-8");
    expect(text).toMatch(/oklch\(/);
    expect(text).not.toMatch(/color-mix\(/);
    expect(text).not.toMatch(/oklch\([^)]*var\(/);
  });

  test("no other src file hard-codes a color, arbitrary pixel size or shadow", () => {
    const files = collectFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap(scan);
    if (violations.length > 0) {
      const report = violations
        .map((v) => `${v.file}:${v.line} — ${v.reason}\n    ${v.snippet}`)
        .join("\n");
      throw new Error(`Raw design values found outside the token files:\n${report}`);
    }
    expect(violations).toEqual([]);
  });
});
