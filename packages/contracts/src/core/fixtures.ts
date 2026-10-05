/**
 * The recorded-fixture format.
 *
 * Fixtures are recorded only from scripted scenarios in throwaway workspaces against a fake
 * OpenAI-compatible provider, never from real sessions (PLAN.md, "Open questions", recorded-session
 * policy). One file per scenario, `<scenario>.fixture.jsonl`: line 1 is the header, every later
 * line is one frame exactly as it crossed omp's stdio. Keys, tokens and auth headers are replaced
 * by `<REDACTED:<kind>>` markers, e-mail addresses by `<EMAIL>`, and absolute paths by the path
 * placeholders below before a fixture is written; `serializeFixture` and `parseFixture` refuse
 * text that still fails `checkScrubbed`.
 */
import { z } from "zod";
import { CapabilityMap } from "./capabilities";
import { type ParseResult, parseJson } from "./errors";
import { INVENTORY_IDS, InventoryId } from "./inventory";
import { OMP_PROTOCOL_VERSIONS, OMP_RPC_MODES } from "./omp";

export const FIXTURE_FORMAT = "omp-app.fixture";
export const FIXTURE_FORMAT_VERSION = 1;
export const FIXTURE_FILE_SUFFIX = ".fixture.jsonl";

/**
 * Stand-ins the header must declare when the frames use them: the scenario's workspace, the home
 * folder and the temp folder for absolute paths, and `<EMAIL>` for an e-mail address.
 */
export const FIXTURE_PLACEHOLDERS = ["<WORKSPACE>", "<HOME>", "<TMP>", "<EMAIL>"] as const;
export type FixturePlaceholder = (typeof FIXTURE_PLACEHOLDERS)[number];

/** Values the recorder replaced with a `<REDACTED:<kind>>` marker, by kind. */
export const REDACTION_KINDS = ["key", "token", "authHeader"] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

const Count = z.int().min(0);

export const FixtureHeader = z.strictObject({
  format: z.literal(FIXTURE_FORMAT),
  formatVersion: z.literal(FIXTURE_FORMAT_VERSION),
  /** Kebab-case; also the file name before `.fixture.jsonl`. */
  scenario: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1),
  recordedAt: z.iso.datetime({ offset: true }),
  source: z.literal("scripted"),
  omp: z.strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    /** The protocol in force after negotiation. */
    protocolVersion: z.union(OMP_PROTOCOL_VERSIONS.map((version) => z.literal(version))),
    mode: z.enum(OMP_RPC_MODES),
    /** omp's command-line arguments, with paths already replaced by placeholders. */
    args: z.array(z.string()),
  }),
  provider: z.strictObject({ kind: z.literal("fake-openai") }),
  /** The capabilities the app derived while recording. */
  capabilities: CapabilityMap,
  /** Every placeholder the frames use. */
  placeholders: z.array(z.enum(FIXTURE_PLACEHOLDERS)),
  /** How many keys, tokens and auth headers were redacted, and how many e-mail addresses and paths became placeholders. */
  redactions: z.strictObject({
    key: Count,
    token: Count,
    authHeader: Count,
    email: Count,
    path: Count,
  }),
  tags: z.array(z.string().min(1)),
  /** Inventory rows the scenario exercises. */
  inventory: z.array(InventoryId.refine((id) => INVENTORY_IDS.has(id), "unknown inventory id")),
});
export type FixtureHeader = z.infer<typeof FixtureHeader>;

export const FixtureFrame = z.strictObject({
  /** Milliseconds since the recording started; never decreases from one frame to the next. */
  t: z.int().min(0),
  /** `stdout`: omp wrote it; `stdin`: the host wrote it. */
  dir: z.enum(["stdout", "stdin"]),
  /** The raw line without its newline (it need not be valid JSON: malformed input is a scenario). */
  line: z.string().refine((line) => !line.includes("\n"), "a frame line holds no newline"),
});
export type FixtureFrame = z.infer<typeof FixtureFrame>;

export interface Fixture {
  header: FixtureHeader;
  frames: FixtureFrame[];
}

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

function fixtureProblems(fixture: Fixture, text: string): string[] {
  const problems = checkScrubbed(text).map(
    (problem) => `line ${problem.line}, column ${problem.column}: ${problem.rule} not scrubbed`,
  );
  const declared = new Set<string>(fixture.header.placeholders);
  for (const placeholder of FIXTURE_PLACEHOLDERS) {
    if (!declared.has(placeholder) && text.includes(placeholder)) {
      problems.push(`placeholder ${placeholder} is used but not declared in the header`);
    }
  }
  for (const [index, frame] of fixture.frames.entries()) {
    const previous = fixture.frames[index - 1];
    if (previous !== undefined && frame.t < previous.t) {
      problems.push(`frame ${index + 1}: t goes backwards (${frame.t} < ${previous.t})`);
    }
  }
  return problems;
}

/** Returns the fixture as JSONL text; throws when it breaks the format or is not scrubbed. */
export function serializeFixture(fixture: Fixture): string {
  const header = FixtureHeader.parse(fixture.header);
  const frames = fixture.frames.map((frame) => FixtureFrame.parse(frame));
  const text = [header, ...frames].map((line) => `${JSON.stringify(line)}\n`).join("");
  const problems = fixtureProblems({ header, frames }, text);
  if (problems.length > 0) throw new Error(`Fixture ${header.scenario}: ${problems.join("; ")}`);
  return text;
}

/** Parses fixture JSONL text; rejects a bad header or frame, and text that is not scrubbed. */
export function parseFixture(text: string): ParseResult<Fixture> {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const [headerLine, ...frameLines] = lines;
  const header = parseJson(FixtureHeader, headerLine ?? "");
  if (!header.ok)
    return { ok: false, error: { ...header.error, message: `header: ${header.error.message}` } };
  const frames: FixtureFrame[] = [];
  for (const [index, frameLine] of frameLines.entries()) {
    const frame = parseJson(FixtureFrame, frameLine);
    if (!frame.ok) {
      const message = `line ${index + 2}: ${frame.error.message}`;
      return { ok: false, error: { ...frame.error, message } };
    }
    frames.push(frame.value);
  }
  const fixture = { header: header.value, frames };
  const problems = fixtureProblems(fixture, text);
  if (problems.length > 0) {
    return {
      ok: false,
      error: { code: "invalid_args", message: problems.join("; "), retryable: false },
    };
  }
  return { ok: true, value: fixture };
}
