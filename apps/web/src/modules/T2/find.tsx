import { z } from "zod";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import {
  decodeFindDetails,
  type FindHit,
  type FindRange,
  FindToolArgsSchema,
  type FindToolDetails,
} from "./models";

const MAX_HIT_ROWS = 20;
const MAX_FAILURE_LINES = 3;

/** Arguments may still be streaming, so every field is optional here. */
const PartialFindArgsSchema = FindToolArgsSchema.partial();

/** omp's tool result is `{ content, details }`; the find details live under `details`. */
const FindResultEnvelopeSchema = z.looseObject({
  content: z.array(z.unknown()),
  details: z.unknown(),
});

export function FindCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const state = normalizeToolRendererProps(rendererProps);
  const args = PartialFindArgsSchema.safeParse(rendererProps.args);
  const result = state.result ?? state.partialResult;
  const details = result === undefined ? undefined : decodeFindDetails(detailsOf(result));
  const parsedDetails = details?.ok ? details.value : undefined;
  const rawResult = rawText(result);
  const settled = state.phase === "success";
  const hits = parsedDetails?.hits ?? [];
  const shownHits = hits.slice(0, MAX_HIT_ROWS).map((hit, index) => hitRow(hit, index));
  const summary = findSummary(args.success ? args.data : undefined, parsedDetails, settled);
  const stats = parsedDetails === undefined ? undefined : statsLine(parsedDetails);
  const failures = parsedDetails?.stats?.failures ?? [];
  const shownFailures = failures.slice(0, MAX_FAILURE_LINES);
  const showNoMatches = settled && parsedDetails !== undefined && hits.length === 0;
  const showUnavailable = settled && parsedDetails === undefined;
  const hasSection =
    shownHits.length > 0 ||
    showNoMatches ||
    showUnavailable ||
    stats !== undefined ||
    failures.length > 0;

  return (
    <div data-testid={`t2-find-card-${state.toolCallId}`}>
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawResult}
        state={state}
        summary={summary}
      />
      {hasSection && (
        <div className="border-border/70 bg-card ms-2 border-s-2 py-2 ps-4 pe-4 text-sm">
          {shownHits.length > 0 && (
            <ul className="flex flex-col gap-2" data-testid="t2-find-hits">
              {shownHits.map((row) => (
                <li className="min-w-0" key={row.key}>
                  <span
                    className="text-foreground block truncate font-mono text-xs"
                    title={row.path}
                  >
                    {row.path}
                  </span>
                  {row.ranges.map((range) => (
                    <div className="min-w-0 text-xs" key={range.key}>
                      {(range.label !== undefined || range.probability !== undefined) && (
                        <div className="flex flex-wrap items-center gap-2">
                          {range.label !== undefined && (
                            <span className="text-foreground">{range.label}</span>
                          )}
                          {range.probability !== undefined && (
                            <span className="text-muted-foreground" title="Match probability">
                              {range.probability}
                            </span>
                          )}
                        </div>
                      )}
                      {range.snippet !== undefined && (
                        <code
                          className="text-muted-foreground block truncate font-mono"
                          title={range.snippet}
                        >
                          {range.snippet}
                        </code>
                      )}
                    </div>
                  ))}
                </li>
              ))}
              {hits.length > shownHits.length && (
                <li className="text-muted-foreground text-xs">
                  Showing {shownHits.length} of {hits.length}
                </li>
              )}
            </ul>
          )}
          {showNoMatches && <p className="text-muted-foreground text-xs">No matches.</p>}
          {showUnavailable && (
            <p className="text-muted-foreground text-xs">Search details unavailable.</p>
          )}
          {stats !== undefined && (
            <p className="text-muted-foreground mt-3 text-xs" data-testid="t2-find-stats">
              {stats}
            </p>
          )}
          {shownFailures.map((failure) => (
            <p
              className="text-muted-foreground mt-1 truncate text-xs"
              data-testid="t2-find-failure"
              key={failure}
              title={failure}
            >
              {failure}
            </p>
          ))}
          {failures.length > shownFailures.length && (
            <p className="text-muted-foreground mt-1 text-xs">
              +{failures.length - shownFailures.length} more
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export const FindToolRenderer: ToolRenderer = (props) => <FindCard rendererProps={props} />;

interface RangeRow {
  readonly key: string;
  readonly label: string | undefined;
  readonly probability: string | undefined;
  readonly snippet: string | undefined;
}

interface HitRow {
  readonly key: string;
  readonly path: string;
  readonly ranges: readonly RangeRow[];
}

function detailsOf(result: unknown): unknown {
  const envelope = FindResultEnvelopeSchema.safeParse(result);
  return envelope.success ? envelope.data.details : result;
}

function hitRow(hit: FindHit, index: number): HitRow {
  const path = hit.rel ?? hit.path ?? `Result ${index + 1}`;
  return {
    key: `${path}#${index}`,
    path,
    ranges: (hit.ranges ?? []).map((range, rangeIndex) => rangeRow(range, rangeIndex)),
  };
}

function rangeRow(range: FindRange, index: number): RangeRow {
  const snippet = range.snippet?.replace(/\s+/g, " ").trim();
  return {
    key: `${range.start ?? range.line ?? "range"}-${range.end ?? ""}#${index}`,
    label: lineLabel(range),
    probability: range.p === undefined ? undefined : `${Math.round(range.p * 100)}%`,
    snippet: snippet === undefined || snippet.length === 0 ? undefined : snippet,
  };
}

function lineLabel(range: FindRange): string | undefined {
  const start = range.start ?? range.line;
  if (start === undefined) return undefined;
  if (range.end === undefined || range.end === start) return `line ${start}`;
  return `lines ${start}–${range.end}`;
}

function findSummary(
  args: { readonly query?: string; readonly path?: string } | undefined,
  details: FindToolDetails | undefined,
  settled: boolean,
): string | undefined {
  const query = nonEmpty(args?.query) ?? nonEmpty(details?.query);
  const path = nonEmpty(args?.path) ?? nonEmpty(details?.scopePath);
  const parts: string[] = [];
  if (query !== undefined) parts.push(query);
  if (path !== undefined) parts.push(query === undefined ? path : `in ${path}`);
  const label = parts.join(" ");
  const hitCount = settled ? (details?.hits?.length ?? 0) : 0;
  const count = hitCount > 0 ? plural(hitCount, "hit") : undefined;
  if (label.length === 0) return count;
  return count === undefined ? label : `${label} · ${count}`;
}

function statsLine(details: FindToolDetails): string | undefined {
  const stats = details.stats;
  const parts: string[] = [];
  if (stats?.requests !== undefined && stats.requests > 0) {
    parts.push(plural(stats.requests, "request"));
  }
  if (stats?.inputTokens !== undefined && stats.inputTokens > 0) {
    parts.push(plural(stats.inputTokens, "input token"));
  }
  if (stats?.outputTokens !== undefined && stats.outputTokens > 0) {
    parts.push(plural(stats.outputTokens, "output token"));
  }
  const elapsedMs = details.elapsedMs ?? stats?.apiMs;
  if (elapsedMs !== undefined) parts.push(`${(elapsedMs / 1000).toFixed(1)} s`);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
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
