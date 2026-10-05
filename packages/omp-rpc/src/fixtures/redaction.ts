/**
 * Proactive redaction applied by {@link FixtureRecorder} before C0's `checkScrubbed` verifies the
 * result. The recorder knows the exact throwaway directories a recording used, so literal path
 * substitution is precise; the pattern-based passes catch anything else `checkScrubbed` looks for
 * (key-shaped strings, bearer/basic credentials, e-mail addresses) so a recording never depends on
 * the scrub check alone to notice a leak.
 */
import type { FixturePlaceholder } from "@omp-app/contracts";

export interface RedactionCounts {
  key: number;
  token: number;
  authHeader: number;
  email: number;
  path: number;
}

export function createRedactionCounts(): RedactionCounts {
  return { key: 0, token: 0, authHeader: 0, email: 0, path: 0 };
}

/** One throwaway absolute directory this recording used, and the placeholder that replaces it. */
export interface PathSubstitution {
  readonly value: string;
  readonly placeholder: FixturePlaceholder;
}

export interface RedactResult {
  readonly text: string;
  readonly counts: RedactionCounts;
}

function countAndReplace(
  text: string,
  search: string,
  replacement: string,
): { text: string; count: number } {
  if (search.length === 0) return { text, count: 0 };
  const parts = text.split(search);
  return { text: parts.join(replacement), count: parts.length - 1 };
}

function applyPathSubstitutions(
  text: string,
  paths: readonly PathSubstitution[],
  counts: RedactionCounts,
): string {
  let result = text;
  // Longest literal first so a substring directory (an agent dir nested in a home dir, say)
  // never leaves a dangling partial prefix for a shorter substitution to mis-replace.
  const ordered = [...paths].sort((a, b) => b.value.length - a.value.length);
  for (const { value, placeholder } of ordered) {
    const replaced = countAndReplace(result, value, placeholder);
    result = replaced.text;
    counts.path += replaced.count;
  }
  return result;
}

const KEY_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|(?:hf|gsk)_[A-Za-z0-9]{30,})/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\\?"(?:api_?key|access_?token|refresh_?token|client_?secret|password|secret)\\?"\s*:\s*\\?"(?!<REDACTED:)[^"\\]{6,}/gi,
];

const BEARER_PATTERN = /\bBearer\s+(?!<REDACTED:)[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC_AUTH_PATTERN =
  /Authorization\\?["']?\s*:\s*\\?["']?Basic\s+(?!<REDACTED:)[A-Za-z0-9+/=]{8,}/gi;
const EMAIL_PATTERN = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w:-])/g;

function replaceAllCounting(
  text: string,
  pattern: RegExp,
  replacement: string | ((match: string) => string),
): { text: string; count: number } {
  let count = 0;
  const replacer = typeof replacement === "string" ? () => replacement : replacement;
  const replaced = text.replace(pattern, (match: string) => {
    count += 1;
    return replacer(match);
  });
  return { text: replaced, count };
}

function applyPatternRedactions(text: string, counts: RedactionCounts): string {
  let result = text;
  for (const pattern of KEY_PATTERNS) {
    const applied = replaceAllCounting(result, pattern, "<REDACTED:key>");
    result = applied.text;
    counts.key += applied.count;
  }
  const bearer = replaceAllCounting(result, BEARER_PATTERN, "Bearer <REDACTED:token>");
  result = bearer.text;
  counts.token += bearer.count;
  const basic = replaceAllCounting(result, BASIC_AUTH_PATTERN, (match) =>
    match.replace(/Basic\s+(?!<REDACTED:)[A-Za-z0-9+/=]{8,}/, "Basic <REDACTED:authHeader>"),
  );
  result = basic.text;
  counts.authHeader += basic.count;
  const email = replaceAllCounting(result, EMAIL_PATTERN, "<EMAIL>");
  result = email.text;
  counts.email += email.count;
  return result;
}

/** Redacts one raw wire line: literal path substitutions first, then pattern-based redaction. */
export function redactLine(line: string, paths: readonly PathSubstitution[]): RedactResult {
  const counts = createRedactionCounts();
  const withPaths = applyPathSubstitutions(line, paths, counts);
  const text = applyPatternRedactions(withPaths, counts);
  return { text, counts };
}

export function addCounts(target: RedactionCounts, source: RedactionCounts): void {
  target.key += source.key;
  target.token += source.token;
  target.authHeader += source.authHeader;
  target.email += source.email;
  target.path += source.path;
}
