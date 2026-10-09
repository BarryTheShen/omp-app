import type { LanguageRegistration } from "shiki/core";

/**
 * Each grammar is imported on first use, so a language nothing shows never reaches the browser, and the
 * build puts every grammar in its own chunk.
 */
const LANGUAGE_LOADERS = {
  bash: () => import("@shikijs/langs/bash").then((module) => module.default),
  c: () => import("@shikijs/langs/c").then((module) => module.default),
  cpp: () => import("@shikijs/langs/cpp").then((module) => module.default),
  csharp: () => import("@shikijs/langs/csharp").then((module) => module.default),
  css: () => import("@shikijs/langs/css").then((module) => module.default),
  diff: () => import("@shikijs/langs/diff").then((module) => module.default),
  dockerfile: () => import("@shikijs/langs/dockerfile").then((module) => module.default),
  go: () => import("@shikijs/langs/go").then((module) => module.default),
  html: () => import("@shikijs/langs/html").then((module) => module.default),
  ini: () => import("@shikijs/langs/ini").then((module) => module.default),
  java: () => import("@shikijs/langs/java").then((module) => module.default),
  javascript: () => import("@shikijs/langs/javascript").then((module) => module.default),
  jsx: () => import("@shikijs/langs/jsx").then((module) => module.default),
  json: () => import("@shikijs/langs/json").then((module) => module.default),
  jsonc: () => import("@shikijs/langs/jsonc").then((module) => module.default),
  kotlin: () => import("@shikijs/langs/kotlin").then((module) => module.default),
  lua: () => import("@shikijs/langs/lua").then((module) => module.default),
  markdown: () => import("@shikijs/langs/markdown").then((module) => module.default),
  php: () => import("@shikijs/langs/php").then((module) => module.default),
  python: () => import("@shikijs/langs/python").then((module) => module.default),
  ruby: () => import("@shikijs/langs/ruby").then((module) => module.default),
  rust: () => import("@shikijs/langs/rust").then((module) => module.default),
  scss: () => import("@shikijs/langs/scss").then((module) => module.default),
  sql: () => import("@shikijs/langs/sql").then((module) => module.default),
  swift: () => import("@shikijs/langs/swift").then((module) => module.default),
  toml: () => import("@shikijs/langs/toml").then((module) => module.default),
  tsx: () => import("@shikijs/langs/tsx").then((module) => module.default),
  typescript: () => import("@shikijs/langs/typescript").then((module) => module.default),
  xml: () => import("@shikijs/langs/xml").then((module) => module.default),
  yaml: () => import("@shikijs/langs/yaml").then((module) => module.default),
} satisfies Record<string, () => Promise<LanguageRegistration[]>>;

export type CodeLanguage = keyof typeof LANGUAGE_LOADERS;

/**
 * Fence names and file extensions that name a language (lowercase). A name not listed here is plain text,
 * which is always a valid answer.
 */
const LANGUAGE_NAMES: ReadonlyMap<string, CodeLanguage> = new Map<string, CodeLanguage>([
  ["bash", "bash"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["c++", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["hpp", "cpp"],
  ["csharp", "csharp"],
  ["c#", "csharp"],
  ["cs", "csharp"],
  ["css", "css"],
  ["diff", "diff"],
  ["patch", "diff"],
  ["dockerfile", "dockerfile"],
  ["docker", "dockerfile"],
  ["go", "go"],
  ["html", "html"],
  ["htm", "html"],
  ["ini", "ini"],
  ["java", "java"],
  ["javascript", "javascript"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["jsx", "jsx"],
  ["json", "json"],
  ["jsonc", "jsonc"],
  ["kotlin", "kotlin"],
  ["kt", "kotlin"],
  ["lua", "lua"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["php", "php"],
  ["python", "python"],
  ["py", "python"],
  ["ruby", "ruby"],
  ["rb", "ruby"],
  ["rust", "rust"],
  ["rs", "rust"],
  ["scss", "scss"],
  ["sql", "sql"],
  ["swift", "swift"],
  ["toml", "toml"],
  ["ts", "typescript"],
  ["typescript", "typescript"],
  ["tsx", "tsx"],
  ["xml", "xml"],
  ["svg", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
]);

/** The language a fence name or a file extension names; undefined means plain text. */
export function resolveCodeLanguage(name: string | undefined): CodeLanguage | undefined {
  const key = name?.trim().toLowerCase();
  if (key === undefined || key === "") return undefined;
  return LANGUAGE_NAMES.get(key);
}

/**
 * The label a file's code block shows, which the code view then resolves: the name of the file's language
 * (`ts` reads `typescript`), its extension when no language is known, `shell` for a `#!` script with no
 * extension, and `text` for anything else. A read's selector (`src/app.ts:10-20`, `:raw`, `:50+20`) is not
 * part of the file name, so it does not change the label.
 */
export function fileLanguageLabel(path: string, firstLine?: string): string {
  const withoutQuery = path.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  const lastSegment = withoutQuery.split(/[\\/]/).pop() ?? "";
  const name = lastSegment.split(":", 1)[0] ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return firstLine?.startsWith("#!") === true ? "shell" : "text";
  const extension = name.slice(dot + 1);
  return resolveCodeLanguage(extension) ?? extension;
}

export function loadCodeLanguage(language: CodeLanguage): Promise<LanguageRegistration[]> {
  return LANGUAGE_LOADERS[language]();
}
