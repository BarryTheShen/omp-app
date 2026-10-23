import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type AttachmentRef,
  type FileSearchCandidate,
  FileSearchPort,
  type FolderPath,
  type GithubReference,
  type GithubReferenceKind,
  GithubRefsPort,
} from "@omp-app/contracts";
import type {
  FileMentionCandidate,
  MentionProvider,
  PromptAction,
  PromptExpansionError,
  PromptExpansionResult,
  TextRange,
  TriggerCandidate,
  TriggerPosition,
  TriggerSearchResult,
} from "../contract";
export interface MentionTriggerMatch {
  readonly trigger: "@" | "#";
  readonly query: string;
  readonly range: TextRange;
  readonly githubKind?: GithubReferenceKind;
  /** For a GitHub reference, the typed `pr` or `issue` word through the caret: the text a chosen row replaces. */
  readonly referenceRange?: TextRange;
}

export interface FileMentionProviderOptions {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly recentPaths?: readonly string[];
  readonly limit?: number;
}

export interface GithubMentionProviderOptions {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly currentRepository?: string;
  readonly limit?: number;
}

const DEFAULT_FILE_LIMIT = 30;
const DEFAULT_GITHUB_LIMIT = 10;
/** One `#` action row: the label, and the plain-words description a person reads under it. */
interface PromptActionRow {
  readonly label: string;
  readonly description: string;
}

/** The `#` action rows in the order the list shows them. Each description says what the row does, in words. */
const ACTIONS: Readonly<Record<PromptAction, PromptActionRow>> = {
  "copy-current-line": {
    label: "Copy current line",
    description: "Copies the line the cursor is on",
  },
  "copy-prompt": {
    label: "Copy whole prompt",
    description: "Copies everything typed so far",
  },
  undo: {
    label: "Undo",
    description: "Takes back the last word typed",
  },
  "cursor-start": {
    label: "Move cursor to message start",
    description: "Moves the cursor to the start of the message",
  },
  "cursor-end": {
    label: "Move cursor to message end",
    description: "Moves the cursor to the end of the message",
  },
  "cursor-line-start": {
    label: "Move cursor to line start",
    description: "Moves the cursor to the start of this line",
  },
  "cursor-line-end": {
    label: "Move cursor to line end",
    description: "Moves the cursor to the end of this line",
  },
};

export interface PromptActionEffect {
  readonly text: string;
  readonly cursor: number;
  readonly copyText?: string;
  readonly undo?: boolean;
}

function errorFrom(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure({ code: "internal", message: fallback, retryable: true }, { cause: error });
}

function errorResult(error: unknown, range?: TextRange): PromptExpansionError {
  const failure = errorFrom(error, "The mention could not be expanded.");
  return {
    kind: "error",
    error: failure.appError,
    replace: range ?? { start: 0, end: 0 },
    preserveText: true,
  };
}

function catalogError(
  error: unknown,
  state: "error" | "unavailable",
): TriggerSearchResult["error"] {
  const failure = errorFrom(error, "Mention search failed.");
  return { state, error: failure.appError };
}

function isBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = text[index - 1];
  return previous === undefined || /[\s([{"'`]/u.test(previous);
}

/** The word a GitHub reference is typed with, `pr` or `pull` or `issue`, just before its `#`, and where that word starts. */
function githubWordBeforeHash(
  text: string,
  hashIndex: number,
): { readonly kind: GithubReferenceKind; readonly start: number } | undefined {
  const word = /(?:^|\s)(pr|pull|issue)\s*$/iu.exec(text.slice(0, hashIndex));
  if (word === null) return undefined;
  const typed = word[1] ?? "";
  return {
    kind: typed.toLocaleLowerCase() === "issue" ? "issue" : "pull-request",
    start: word.index + word[0].indexOf(typed),
  };
}

function queryForTrigger(text: string, triggerIndex: number, cursor: number): string | null {
  const after = text.slice(triggerIndex + 1, cursor);
  if (after.startsWith('"')) {
    if (after.endsWith('"')) return null;
    return after.slice(1);
  }
  const whitespace = after.search(/[\s]/u);
  return whitespace >= 0 ? after.slice(0, whitespace) : after;
}

/** Finds an active @ path or # action/GitHub token at any caret position. */
export function detectMentionTrigger(
  text: string,
  cursorPosition = text.length,
): MentionTriggerMatch | null {
  const cursor = Math.max(0, Math.min(cursorPosition, text.length));
  for (let index = cursor - 1; index >= 0; index -= 1) {
    const character = text[index];
    if (character !== "@" && character !== "#") continue;
    if (!isBoundary(text, index)) continue;
    // A # takes a reference only while no space stands between it and the caret. A space right after the #
    // makes a heading (issue 1333); a space before the caret ends the reference, so the text past it is prose (issue 1340).
    if (
      character === "#" &&
      (/\s/u.test(text.charAt(index + 1)) || /\s/u.test(text.slice(index + 1, cursor)))
    ) {
      return null;
    }
    const query = queryForTrigger(text, index, cursor);
    if (query === null) continue;
    const reference = character === "#" ? githubWordBeforeHash(text, index) : undefined;
    return {
      trigger: character,
      query,
      range: { start: index, end: cursor },
      ...(reference
        ? {
            githubKind: reference.kind,
            referenceRange: { start: reference.start, end: cursor },
          }
        : {}),
    };
  }
  return null;
}

function normalizedQuery(query: string): string {
  return query.trim().replaceAll("\\", "/").replace(/^"|"$/gu, "").toLocaleLowerCase();
}

function matchQuality(path: string, query: string): number | null {
  const normalizedPath = path.toLocaleLowerCase();
  if (query.length === 0) return 0;
  const segments = normalizedPath.split("/");
  if (normalizedPath === query || segments.some((segment) => segment === query)) return 0;
  if (segments.some((segment) => segment.startsWith(`${query}.`))) return 1;
  if (normalizedPath.startsWith(query)) return 2;
  if (normalizedPath.includes(query)) return 3;
  let cursor = 0;
  for (const character of query) {
    const found = normalizedPath.indexOf(character, cursor);
    if (found < 0) return null;
    cursor = found + 1;
  }
  return 4;
}

function fuzzyScore(path: string, query: string): number | null {
  const normalizedPath = path.toLocaleLowerCase();
  if (query.length === 0) return 0;
  const substring = normalizedPath.indexOf(query);
  if (substring >= 0) return 1_200 - substring * 4 - (path.length - query.length);
  let cursor = 0;
  let gaps = 0;
  let previous = -1;
  for (const character of query) {
    const found = normalizedPath.indexOf(character, cursor);
    if (found < 0) return null;
    if (previous >= 0) gaps += found - previous - 1;
    previous = found;
    cursor = found + 1;
  }
  return 700 - gaps * 8 - Math.max(0, path.length - query.length);
}
export function rankFileMentions(
  candidates: readonly FileMentionCandidate[],
  query: string,
  recentPaths: readonly string[] = [],
): readonly FileMentionCandidate[] {
  const normalized = normalizedQuery(query);
  const recent = new Map(recentPaths.map((path, index) => [path, index]));
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      fuzzy: fuzzyScore(candidate.path.toLocaleLowerCase(), normalized),
      quality: matchQuality(candidate.path, normalized),
      recentIndex: recent.get(candidate.path) ?? Number.MAX_SAFE_INTEGER,
    }))
    .filter((entry) => entry.fuzzy !== null && entry.quality !== null)
    .sort((left, right) => {
      if (normalized.length === 0 && left.recentIndex !== right.recentIndex) {
        return left.recentIndex - right.recentIndex;
      }
      if (left.quality !== right.quality) return (left.quality ?? 99) - (right.quality ?? 99);
      if (left.candidate.path.length !== right.candidate.path.length) {
        return left.candidate.path.length - right.candidate.path.length;
      }
      if (left.fuzzy !== right.fuzzy) return (right.fuzzy ?? 0) - (left.fuzzy ?? 0);
      if (left.candidate.score !== right.candidate.score) {
        return right.candidate.score - left.candidate.score;
      }
      if (left.recentIndex !== right.recentIndex) return left.recentIndex - right.recentIndex;
      const path = left.candidate.path.localeCompare(right.candidate.path);
      return path !== 0 ? path : left.index - right.index;
    })
    .map((entry) => entry.candidate);
}

function parseLineRange(query: string): {
  readonly pathQuery: string;
  readonly lineRange?: FileMentionCandidate["lineRange"];
} {
  const normalized = normalizedQuery(query);
  const match = normalized.match(/^(.*?):(\d+)(?:-(\d+))?$/u);
  if (!match) return { pathQuery: normalized };
  const start = Number(match[2]);
  const end = Number(match[3] ?? match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    return { pathQuery: normalized };
  }
  return { pathQuery: match[1] ?? normalized, lineRange: { start, end } };
}

function quotePath(path: string): string {
  if (!/[\s"']/u.test(path)) return path;
  return `"${path.replaceAll('"', '\\"')}"`;
}

export function formatFileMentionInsertion(
  candidate: Pick<FileMentionCandidate, "path" | "lineRange">,
): string {
  const line = candidate.lineRange
    ? `:${candidate.lineRange.start}${candidate.lineRange.end === candidate.lineRange.start ? "" : `-${candidate.lineRange.end}`}`
    : "";
  return `@${quotePath(`${candidate.path}${line}`)} `;
}

function fileAttachment(candidate: FileMentionCandidate): AttachmentRef {
  const line = candidate.lineRange
    ? `:${candidate.lineRange.start}${candidate.lineRange.end === candidate.lineRange.start ? "" : `-${candidate.lineRange.end}`}`
    : "";
  return {
    id: `file:${candidate.path}${line}`,
    name: `${candidate.path}${line}`,
    mediaType: "text/plain",
  };
}

function mapFileCandidate(
  candidate: FileSearchCandidate,
  lineRange?: FileMentionCandidate["lineRange"],
): FileMentionCandidate {
  return { ...candidate, ...(lineRange ? { lineRange } : {}) };
}

function fileTriggerCandidate(candidate: FileMentionCandidate): TriggerCandidate {
  return {
    id: `file:${candidate.path}${candidate.lineRange ? `:${candidate.lineRange.start}` : ""}`,
    kind: "file",
    source: "a1.file-search",
    label: candidate.path,
    insertText: formatFileMentionInsertion(candidate),
    metadata: {
      path: candidate.path,
      kind: candidate.kind,
      ...(candidate.lineRange ? { lineRange: candidate.lineRange } : {}),
    },
  };
}

function mapSearchResult(
  candidates: readonly FileSearchCandidate[],
  query: string,
  recentPaths: readonly string[],
): readonly TriggerCandidate[] {
  const parsed = parseLineRange(query);
  const ranked = rankFileMentions(
    candidates.map((candidate) => mapFileCandidate(candidate, parsed.lineRange)),
    parsed.pathQuery,
    recentPaths,
  );
  return ranked.map(fileTriggerCandidate);
}

export function createFileMentionProvider(options: FileMentionProviderOptions): MentionProvider {
  const port = options.client.port(FileSearchPort);
  const searchTyped = async (
    query: string,
    position?: TriggerPosition,
  ): Promise<TriggerSearchResult> => {
    const parsed = parseLineRange(query);
    try {
      const result = await port.search({
        folder: options.folder,
        query: parsed.pathQuery,
        limit: options.limit ?? DEFAULT_FILE_LIMIT,
      });
      const candidates = mapSearchResult(result.results, query, options.recentPaths ?? []);
      return {
        state: "ready",
        candidates: candidates.map((candidate) =>
          position ? { ...candidate, position } : candidate,
        ),
        ...(result.truncated ? { revision: "truncated" } : {}),
      };
    } catch (error) {
      const failure = errorFrom(error, "Workspace file search failed.");
      return {
        state: failure.appError.code === "unavailable" ? "unavailable" : "error",
        candidates: [],
        error: catalogError(
          failure,
          failure.appError.code === "unavailable" ? "unavailable" : "error",
        ),
      };
    }
  };
  return {
    trigger: "@",
    kind: "file",
    source: "a1.file-search",
    search: async (query) => (await searchTyped(query)).candidates,
    searchTyped,
  };
}
/** A `#` query that names GitHub: a `#<number>` reference, or a title search (`pr <text>`, `issue <text>`). */
type GithubQuery =
  | {
      readonly kind: "number";
      readonly number: string;
      readonly githubKinds: readonly GithubReferenceKind[];
    }
  | {
      readonly kind: "search";
      readonly githubKind: GithubReferenceKind;
      readonly searchQuery: string;
    };

const BOTH_GITHUB_KINDS: readonly GithubReferenceKind[] = ["pull-request", "issue"];

/**
 * What a `#` query names on GitHub, or null for a query that does not (a bare `#`, or a word that is an action). `123`,
 * `pr 123` and `issue 123` are `#<number>` references, shaped as omp's github-ref-autocomplete.ts:1-30 has them: `0` is
 * not one (omp's `[1-9]\d*`), and naming the type constrains the rows to that kind. Other `pr <text>` and `issue <text>`
 * queries search titles through gh.
 */
function githubQueryOf(query: string): GithubQuery | null {
  const normalized = query.trim();
  const numbered = /^(?:(pr|pull|issue)\s+)?([1-9]\d*)$/iu.exec(normalized);
  if (numbered) {
    const word = numbered[1]?.toLocaleLowerCase();
    return {
      kind: "number",
      number: numbered[2] ?? "",
      githubKinds:
        word === undefined ? BOTH_GITHUB_KINDS : [word === "issue" ? "issue" : "pull-request"],
    };
  }
  const search = /^(pr|pull|issue)\s+(.+)$/iu.exec(normalized);
  if (search) {
    return {
      kind: "search",
      githubKind: search[1]?.toLocaleLowerCase() === "issue" ? "issue" : "pull-request",
      searchQuery: search[2] ?? "",
    };
  }
  return null;
}

/**
 * omp's `#<number>` rows, built locally: a PR and an Issue, or only the kind the type names (github-ref-autocomplete.ts:61-74).
 * No network is asked for them, so a missing or refused gh does not touch them.
 */
function numberCandidates(
  number: string,
  githubKinds: readonly GithubReferenceKind[],
): readonly TriggerCandidate[] {
  return githubKinds.map((githubKind): TriggerCandidate => {
    const scheme = githubKind === "pull-request" ? "pr" : "issue";
    return {
      id: `github:local:${scheme}:${number}`,
      kind: "github",
      source: "client",
      label: `${scheme === "pr" ? "PR" : "Issue"} #${number}`,
      description: scheme === "pr" ? "GitHub pull request" : "GitHub issue",
      insertText: `${scheme}://${number} `,
      metadata: { number: Number(number), githubKind },
    };
  });
}

/** The name of the `#` list: GitHub suggestions for a reference (a number, or a pr or issue search), else omp's message actions. */
export function hashListName(query: string): "GitHub suggestions" | "Message actions" {
  return githubQueryOf(query) === null ? "Message actions" : "GitHub suggestions";
}

/**
 * Matches omp v18.6.1's `github-ref-autocomplete.ts`: short URLs resolve against the current
 * session repository, while owner/repository/number URLs name another repository. The corresponding
 * `issue-pr-protocol.ts` resolver accepts those exact shapes.
 * Sources:
 * https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.1/packages/coding-agent/src/modes/github-ref-autocomplete.ts
 * https://raw.githubusercontent.com/can1357/oh-my-pi/v18.6.1/packages/coding-agent/src/internal-urls/issue-pr-protocol.ts
 */
function githubTriggerCandidate(
  candidate: GithubReference,
  currentRepository: string | undefined,
): TriggerCandidate {
  const prefix = candidate.kind === "pull-request" ? "pr" : "issue";
  const repository = candidate.repository;
  const isCurrentRepository =
    repository === undefined ||
    (currentRepository !== undefined &&
      repository.toLocaleLowerCase() === currentRepository.toLocaleLowerCase());
  const target = isCurrentRepository
    ? `${prefix}://${candidate.number}`
    : `${prefix}://${repository}/${candidate.number}`;
  const state = candidate.state === "unknown" ? undefined : candidate.state;
  return {
    id: `github:${repository ?? "current"}:${prefix}:${candidate.number}`,
    kind: "github",
    source: "a1.github-refs",
    label: `${candidate.kind === "pull-request" ? "PR" : "Issue"} #${candidate.number}`,
    description: `${candidate.title}${state ? ` · ${state}` : ""}`,
    insertText: `${target} `,
    metadata: {
      ...(repository ? { repository } : {}),
      number: candidate.number,
      githubKind: candidate.kind,
    },
  };
}

function actionCandidates(query: string): readonly TriggerCandidate[] {
  const normalized = query.trim().toLocaleLowerCase();
  return (Object.entries(ACTIONS) as Array<[PromptAction, PromptActionRow]>)
    .filter(
      ([action, { label }]) =>
        normalized.length === 0 ||
        action.includes(normalized) ||
        label.toLocaleLowerCase().includes(normalized),
    )
    .map(([action, { label, description }]) => ({
      id: `action:${action}`,
      kind: "prompt-action" as const,
      source: "client" as const,
      label,
      description,
      insertText: "",
      metadata: { action },
    }));
}

/** The start and the end of the line the caret is on: the end is the newline after it, or the end of the text. */
function lineBounds(
  text: string,
  cursor: number,
): { readonly start: number; readonly end: number } {
  const start = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const newline = text.indexOf("\n", cursor);
  return { start, end: newline < 0 ? text.length : newline };
}

export function executePromptAction(
  action: PromptAction,
  text: string,
  cursorPosition: number,
): PromptActionEffect {
  const cursor = Math.max(0, Math.min(cursorPosition, text.length));
  switch (action) {
    case "copy-current-line": {
      const { start, end } = lineBounds(text, cursor);
      return { text, cursor, copyText: text.slice(start, end) };
    }
    case "copy-prompt":
      return { text, cursor, copyText: text };
    case "undo":
      return { text, cursor, undo: true };
    case "cursor-start":
      return { text, cursor: 0 };
    case "cursor-end":
      return { text, cursor: text.length };
    case "cursor-line-start":
      return { text, cursor: lineBounds(text, cursor).start };
    case "cursor-line-end":
      return { text, cursor: lineBounds(text, cursor).end };
  }
}

export function createGithubMentionProvider(
  options: GithubMentionProviderOptions,
): MentionProvider {
  const port = options.client.port(GithubRefsPort);
  const searchTyped = async (
    query: string,
    position?: TriggerPosition,
  ): Promise<TriggerSearchResult> => {
    const placed = (candidates: readonly TriggerCandidate[]): TriggerCandidate[] =>
      position ? candidates.map((candidate) => ({ ...candidate, position })) : [...candidates];
    const reference = githubQueryOf(query);
    // A #<number> asks nothing: its rows are built here, so a missing or refused gh changes nothing.
    if (reference?.kind === "number") {
      return {
        state: "ready",
        candidates: placed(numberCandidates(reference.number, reference.githubKinds)),
      };
    }
    const actions = placed(actionCandidates(query));
    if (reference === null) return { state: "ready", candidates: actions };
    try {
      const result = await port.search({
        folder: options.folder,
        query: reference.searchQuery,
        kind: reference.githubKind,
        limit: options.limit ?? DEFAULT_GITHUB_LIMIT,
      });
      return {
        state: "ready",
        candidates: [
          ...actions,
          ...placed(
            result.candidates.map((candidate) =>
              githubTriggerCandidate(candidate, options.currentRepository),
            ),
          ),
        ],
        ...(result.truncated ? { revision: "truncated" } : {}),
      };
    } catch (error) {
      const failure = errorFrom(error, "GitHub reference search failed.");
      return {
        state: failure.appError.code === "unavailable" ? "unavailable" : "error",
        candidates: actions,
        error: catalogError(
          failure,
          failure.appError.code === "unavailable" ? "unavailable" : "error",
        ),
      };
    }
  };
  return {
    trigger: "#",
    kind: "github",
    source: "a1.github-refs",
    search: async (query) => (await searchTyped(query)).candidates,
    searchTyped,
  };
}

function replaceRange(
  text: string,
  range: TextRange,
  replacement: string,
): { readonly text: string; readonly cursor: number } {
  return {
    text: `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`,
    cursor: range.start + replacement.length,
  };
}

export function isPromptAction(value: unknown): value is PromptAction {
  return typeof value === "string" && Object.hasOwn(ACTIONS, value);
}

function metadataLineRange(value: unknown): FileMentionCandidate["lineRange"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("start" in value) || !("end" in value)) return undefined;
  const start = value.start;
  const end = value.end;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start
  ) {
    return undefined;
  }
  return { start, end };
}

export function expandMention(
  text: string,
  match: MentionTriggerMatch,
  candidate: TriggerCandidate,
): PromptExpansionResult {
  if (candidate.kind === "prompt-action") {
    const replaced = replaceRange(text, match.range, "");
    const action = isPromptAction(candidate.metadata?.action)
      ? candidate.metadata.action
      : undefined;
    return {
      kind: "expanded",
      text: replaced.text,
      replace: match.range,
      cursor: replaced.cursor,
      attachmentRefs: [],
      ...(action ? { action } : {}),
    };
  }
  const replacement = candidate.insertText ?? "";
  // A GitHub reference covers the word typed before its #, so the replacement starts at that word.
  const target = match.referenceRange ?? match.range;
  const range =
    replacement.endsWith(" ") && text[target.end] === " "
      ? { start: target.start, end: target.end + 1 }
      : target;
  const replaced = replaceRange(text, range, replacement);
  const lineRange = metadataLineRange(candidate.metadata?.lineRange);
  const attachmentRefs =
    candidate.kind === "file" && typeof candidate.metadata?.path === "string"
      ? [
          fileAttachment({
            path: candidate.metadata.path,
            kind: candidate.metadata.kind === "directory" ? "directory" : "file",
            score: 0,
            ...(lineRange ? { lineRange } : {}),
          }),
        ]
      : [];
  return {
    kind: "expanded",
    text: replaced.text,
    replace: range,
    cursor: replaced.cursor,
    attachmentRefs,
  };
}

export function expansionError(error: unknown, match: MentionTriggerMatch): PromptExpansionResult {
  return errorResult(error, match.range);
}
