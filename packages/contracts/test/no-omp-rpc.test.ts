import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The gate of SDK plan H5.6f: the app reaches omp through its chat host on omp's SDK only. Nothing in it imports omp's
 * RPC mode, launches omp in it, or uses the removed `omp-rpc` package. Comments may cite omp's RPC source files as
 * history, and omp's own names that contain "rpc" (`refreshRpcHostTools`, the goal continuation mode `rpc`) are omp's.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");
const TREES = ["apps", "packages", "tools", "scripts", "packaging", ".github"];
const SKIPPED = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".data",
  "archive",
  "test-results",
  "playwright-report",
]);
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const OTHER = /\.(?:sh|ya?ml|json|toml)$/;
const THIS_FILE = relative(ROOT, import.meta.path);

const RULES: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  {
    name: "an import of omp's RPC mode",
    pattern: /(?:from\s+|import\(\s*|require\(\s*)["'][^"']*modes\/rpc\b/,
  },
  { name: "omp's RPC launch mode", pattern: /\brpc-ui\b|--mode["',\s]+rpc\b/ },
  { name: "the removed omp-rpc package", pattern: /\bomp-rpc\b/ },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIPPED.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (SCRIPT.test(entry) || OTHER.test(entry)) out.push(path);
  }
  return out;
}

/** A script's text with its `//` and `/* *\/` comments blanked; strings, template literals and regex bodies are kept. */
export function withoutComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += next;
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const comment = text.slice(index, end === -1 ? text.length : end + 2);
      out += comment.replace(/[^\n]/g, " ");
      index += comment.length - 1;
    } else {
      out += char;
    }
  }
  return out;
}

describe("H5.6f: the app speaks no omp RPC", () => {
  test("no file imports omp's RPC mode, launches omp in it, or names the omp-rpc package", () => {
    const offences: string[] = [];
    for (const tree of TREES) {
      for (const path of sourceFiles(join(ROOT, tree))) {
        const name = relative(ROOT, path);
        if (name === THIS_FILE) continue;
        const raw = readFileSync(path, "utf8");
        const code = SCRIPT.test(path) ? withoutComments(raw) : raw;
        for (const rule of RULES) {
          // The package's name is gone from comments too; the other two rules read the code only.
          const text = rule.name === "the removed omp-rpc package" ? raw : code;
          if (rule.pattern.test(text)) offences.push(`${name}: ${rule.name}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  test("comments are blanked, and strings, template literals and line breaks are kept", () => {
    const text = [
      "// a comment naming rpc-ui",
      'const a = "rpc-ui"; /* and',
      "  rpc-ui here */ const b = `// not a comment`;",
    ].join("\n");
    const code = withoutComments(text);
    expect(code.split("\n")).toHaveLength(3);
    expect(code.match(/rpc-ui/g)).toHaveLength(1);
    expect(code).toContain("`// not a comment`");
  });
});
