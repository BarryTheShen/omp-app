import { z } from "zod";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { AstGrepToolArgsSchema, type AstGrepToolDetails, decodeAstGrepDetails } from "./models";

const MAX_MATCH_ROWS = 20;
const MAX_PARSE_ERROR_LINES = 3;

/** Arguments may still be streaming, so every field is optional here. */
const PartialAstGrepArgsSchema = AstGrepToolArgsSchema.partial();

/** omp's tool result is `{ content, details }`; the ast_grep details live under `details`. */
const AstGrepResultEnvelopeSchema = z.looseObject({
  content: z.array(z.unknown()),
  details: z.unknown(),
});

/** omp's grouped display rows (packages/tui/src/tools/grouped-file-output.ts:143-145,302). */
const GROUPED_HEADER_RE = /^(#+)\s+(.*)$/;
const HEADER_SUFFIX_RE = /\s+\([^)]*\)\s*$/;
const HEADER_HASH_TAG_RE = /#[0-9a-f]+$/i;
const NUMBERED_LINE_RE = /^\s*(\*?)(\d+)(?:│|[:|])(.*)$/;

interface MatchRow {
  readonly key: string;
  readonly line: number;
  readonly snippet: string;
}

interface FileGroup {
  readonly path: string;
  /** omp's per-file match count, shown when the display rows are missing. */
  readonly count: number | undefined;
  readonly matches: MatchRow[];
}

export function AstGrepCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const state = normalizeToolRendererProps(rendererProps);
  const args = PartialAstGrepArgsSchema.safeParse(rendererProps.args);
  const result = state.result ?? state.partialResult;
  const details = result === undefined ? undefined : decodeAstGrepDetails(detailsOf(result));
  const parsedDetails = details?.ok ? details.value : undefined;
  const rawResult = rawText(result);
  const settled = state.phase === "success";
  const groups = parsedDetails === undefined ? [] : matchGroups(parsedDetails);
  const shownGroups = limitGroups(groups, MAX_MATCH_ROWS);
  const shownMatches = shownGroups.reduce((total, group) => total + group.matches.length, 0);
  const parsedMatches = groups.reduce((total, group) => total + group.matches.length, 0);
  const totalMatches = parsedDetails?.matchCount ?? parsedMatches;
  const summary = astGrepSummary(
    args.success ? args.data : undefined,
    parsedDetails,
    settled ? totalMatches : 0,
  );
  const stats = parsedDetails === undefined ? undefined : statsLine(parsedDetails);
  const parseErrors = parsedDetails?.parseErrors ?? [];
  const parseErrorTotal = Math.max(parsedDetails?.parseErrorsTotal ?? 0, parseErrors.length);
  const shownParseErrors = parseErrors.slice(0, MAX_PARSE_ERROR_LINES);
  const showNoMatches = settled && parsedDetails !== undefined && totalMatches === 0;
  const showUnavailable = settled && parsedDetails === undefined;
  const limitReached = parsedDetails?.limitReached === true;
  const hasSection =
    shownGroups.length > 0 ||
    showNoMatches ||
    showUnavailable ||
    stats !== undefined ||
    parseErrors.length > 0 ||
    limitReached;

  return (
    <div data-testid={`t2-ast-grep-card-${state.toolCallId}`}>
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawResult}
        state={state}
        summary={summary}
        summaryClassName="text-muted-foreground font-mono"
      />
      {hasSection && (
        <div className="border-border/70 bg-card ms-2 border-s-2 py-2 ps-4 pe-4 text-sm">
          {shownGroups.length > 0 && (
            <ul className="flex flex-col gap-2" data-testid="t2-ast-grep-matches">
              {shownGroups.map((group) => (
                <li className="min-w-0" key={group.path}>
                  <span
                    className="text-foreground block truncate font-mono text-xs"
                    title={group.path}
                  >
                    {group.path}
                  </span>
                  {group.matches.length === 0 && group.count !== undefined && (
                    <span className="text-muted-foreground text-xs">
                      {plural(group.count, "match", "matches")}
                    </span>
                  )}
                  {group.matches.map((match) => (
                    <div className="flex min-w-0 items-baseline gap-2 text-xs" key={match.key}>
                      <span className="text-foreground shrink-0">line {match.line}</span>
                      {match.snippet.length > 0 && (
                        <code
                          className="text-muted-foreground min-w-0 truncate font-mono"
                          title={match.snippet}
                        >
                          {match.snippet}
                        </code>
                      )}
                    </div>
                  ))}
                </li>
              ))}
              {shownMatches > 0 && totalMatches > shownMatches && (
                <li className="text-muted-foreground text-xs">
                  Showing {shownMatches} of {totalMatches}
                </li>
              )}
            </ul>
          )}
          {showNoMatches && <p className="text-muted-foreground text-xs">No matches.</p>}
          {showUnavailable && (
            <p className="text-muted-foreground text-xs">Search details unavailable.</p>
          )}
          {limitReached && (
            <p className="text-muted-foreground mt-3 text-xs" data-testid="t2-ast-grep-limit">
              Stopped at the match limit; narrow the path to see the rest.
            </p>
          )}
          {stats !== undefined && (
            <p className="text-muted-foreground mt-3 text-xs" data-testid="t2-ast-grep-stats">
              {stats}
            </p>
          )}
          {shownParseErrors.map((parseError) => (
            <p
              className="text-muted-foreground mt-1 truncate text-xs"
              data-testid="t2-ast-grep-parse-error"
              key={parseError}
              title={parseError}
            >
              {parseError}
            </p>
          ))}
          {parseErrorTotal > shownParseErrors.length && (
            <p className="text-muted-foreground mt-1 text-xs">
              +{parseErrorTotal - shownParseErrors.length} more
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export const AstGrepToolRenderer: ToolRenderer = (props) => <AstGrepCard rendererProps={props} />;

function detailsOf(result: unknown): unknown {
  const envelope = AstGrepResultEnvelopeSchema.safeParse(result);
  return envelope.success ? envelope.data.details : result;
}

/**
 * Groups omp's display rows by file, keeping only the first line of each match. Without display
 * text, files still appear with their counts from `fileMatches`.
 */
function matchGroups(details: AstGrepToolDetails): FileGroup[] {
  if (details.displayContent === undefined) {
    return (details.fileMatches ?? []).map((file) => ({
      path: file.path,
      count: file.count,
      matches: [],
    }));
  }
  const groups: FileGroup[] = [];
  const dirAtDepth: string[] = [];
  let current: FileGroup | undefined;
  for (const line of details.displayContent.split("\n")) {
    const header = GROUPED_HEADER_RE.exec(line);
    if (header !== null) {
      const depth = header[1]?.length ?? 1;
      const rest = (header[2] ?? "").trimEnd();
      dirAtDepth.length = depth - 1;
      if (rest.endsWith("/")) {
        dirAtDepth[depth - 1] = rest.slice(0, -1).replace(HEADER_SUFFIX_RE, "");
        current = undefined;
        continue;
      }
      const name = rest.replace(HEADER_SUFFIX_RE, "").replace(HEADER_HASH_TAG_RE, "");
      const prefix = dirAtDepth.filter(Boolean).join("/");
      current = {
        path: prefix.length > 0 ? `${prefix}/${name}` : name,
        count: undefined,
        matches: [],
      };
      groups.push(current);
      continue;
    }
    const numbered = NUMBERED_LINE_RE.exec(line);
    if (numbered === null || numbered[1] !== "*") continue;
    if (current === undefined) {
      current = {
        path: details.files?.[0] ?? details.scopePath ?? "Matched file",
        count: undefined,
        matches: [],
      };
      groups.push(current);
    }
    const lineNumber = Number(numbered[2]);
    current.matches.push({
      key: `${lineNumber}#${current.matches.length}`,
      line: lineNumber,
      snippet: (numbered[3] ?? "").trim(),
    });
  }
  return groups;
}

function limitGroups(groups: readonly FileGroup[], maxRows: number): FileGroup[] {
  const shown: FileGroup[] = [];
  let remaining = maxRows;
  for (const group of groups) {
    if (remaining <= 0) break;
    const matches = group.matches.slice(0, remaining);
    remaining -= Math.max(matches.length, 1);
    shown.push({ path: group.path, count: group.count, matches });
  }
  return shown;
}

function astGrepSummary(
  args: { readonly pat?: string; readonly path?: string } | undefined,
  details: AstGrepToolDetails | undefined,
  matchCount: number,
): string | undefined {
  const pattern = args?.pat?.replace(/\s+/g, " ").trim();
  const scope = args?.path?.trim() || details?.scopePath;
  const parts: string[] = [];
  if (pattern !== undefined && pattern.length > 0) parts.push(pattern);
  if (scope !== undefined && scope.length > 0) parts.push(`in ${scope}`);
  if (matchCount > 0) parts.push(`· ${plural(matchCount, "match", "matches")}`);
  return parts.length === 0 ? undefined : parts.join(" ");
}

function statsLine(details: AstGrepToolDetails): string | undefined {
  const parts: string[] = [];
  if (details.matchCount !== undefined && details.matchCount > 0) {
    const files =
      details.fileCount === undefined ? "" : ` in ${plural(details.fileCount, "file", "files")}`;
    parts.push(`${plural(details.matchCount, "match", "matches")}${files}`);
  }
  if (details.filesSearched !== undefined && details.filesSearched > 0) {
    parts.push(`${plural(details.filesSearched, "file", "files")} searched`);
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "The search result could not be shown as text.";
  }
}
