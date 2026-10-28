/**
 * The privacy check for committed fixtures and recordings.
 *
 * Fixtures are recorded only from scripted scenarios in throwaway workspaces against a fake OpenAI-compatible provider,
 * never from real sessions (PLAN.md, "Open questions", recorded-session policy). Before one is committed, keys, tokens
 * and auth headers are replaced by `<REDACTED:<kind>>` markers, e-mail addresses by `<EMAIL>`, and absolute paths by
 * placeholders (`<WORKSPACE>`, `<HOME>`, `<TMP>`, `<WORKSPACE_BUCKET>`); `checkScrubbed` reports text that still holds one.
 */

export type ScrubRule = "path" | "key" | "token" | "email";

/**
 * Absolute paths under these roots must become placeholders: home folders, temp folders, mounts,
 * `/opt` and `/srv`. System roots that tool output names legitimately (`/usr`, `/bin`, `/sbin`,
 * `/lib`, `/lib64`, `/etc`, `/dev`, `/proc`, `/sys`, …) are not listed and may stay.
 */
export const PRIVATE_PATH_ROOTS = [
  "/home",
  "/Users",
  "/root",
  "/tmp",
  "/var/tmp",
  "/var/folders",
  "/var/home",
  "/private/tmp",
  "/private/var/tmp",
  "/private/var/folders",
  "/srv",
  "/mnt",
  "/media",
  "/Volumes",
  "/opt",
  "/run/user",
] as const;

/** Where unscrubbed text was found; never carries the matched text itself. */
export interface ScrubProblem {
  /** 1-based line in the fixture text. */
  line: number;
  /** 1-based column of the match. */
  column: number;
  rule: ScrubRule;
}

const SCRUB_PATTERNS: ReadonlyArray<{ rule: ScrubRule; pattern: RegExp }> = [
  // A private root at the start of an absolute path, with or without more segments. A path after
  // a placeholder (`<WORKSPACE>/tmp/x`), inside a relative path or URL, or a longer name
  // (`/optimize`) does not count.
  {
    rule: "path",
    pattern: new RegExp(
      `(?<![\\w.>~-])(?:${PRIVATE_PATH_ROOTS.join("|")})(?=[/\\\\\\s"'\`,;:)\\]}]|\\.(?!\\w)|$)`,
      "g",
    ),
  },
  // Every Windows drive path (`C:\Users\…`, `C:\tmp\…`, `D:/work`), system folders included: the
  // allowed system roots are POSIX ones.
  { rule: "path", pattern: /(?<!\w)[A-Za-z]:(?:\\{1,2}|\/)(?=[^\\/\s"'`<>|?*:])/g },
  // omp's session bucket names encode an absolute cwd outside home and the temp root with dashes
  // (`/home/alice/work` → `--home-alice-work--`, session-paths.ts encodeLegacyAbsoluteSessionDirName),
  // which hides a private path from the rule above.
  {
    rule: "path",
    pattern: new RegExp(
      `(?<![\\w-])--(?:${PRIVATE_PATH_ROOTS.map((root) => root.slice(1)).join("|")})-[^\\s"'\`/\\\\]+`,
      "g",
    ),
  },
  // Provider and platform key formats.
  { rule: "key", pattern: /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g },
  { rule: "key", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { rule: "key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "key", pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { rule: "key", pattern: /\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|(?:hf|gsk)_[A-Za-z0-9]{30,})/g },
  { rule: "key", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { rule: "key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  // A secret-named JSON field (also inside JSON-escaped text) whose value is not a marker.
  {
    rule: "key",
    pattern:
      /\\?"(?:api_?key|access_?token|refresh_?token|client_?secret|password|secret)\\?"\s*:\s*\\?"(?!<REDACTED:)[^"\\]{6,}/gi,
  },
  // Bearer credentials, and basic credentials in an Authorization header, not replaced by a marker.
  { rule: "token", pattern: /\bBearer\s+(?!<REDACTED:)[A-Za-z0-9._~+/=-]{8,}/gi },
  {
    rule: "token",
    pattern: /Authorization\\?["']?\s*:\s*\\?["']?Basic\s+(?!<REDACTED:)[A-Za-z0-9+/=]{8,}/gi,
  },
  // An e-mail address; `user@host:path` (scp-style git remotes) is not one.
  {
    rule: "email",
    pattern: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w:-])/g,
  },
];

/**
 * The scrub check: reports absolute paths under a private root or on a Windows drive, key-shaped
 * strings, bearer (or basic) credentials and e-mail addresses anywhere in the text. An empty
 * result means the text passed.
 */
export function checkScrubbed(text: string): ScrubProblem[] {
  const problems: ScrubProblem[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const { rule, pattern } of SCRUB_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        problems.push({ line: index + 1, column: match.index + 1, rule });
      }
    }
  }
  return problems;
}
