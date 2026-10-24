import { z } from "zod";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { decodeGlobArgs, decodeGlobDetails, type GlobToolDetails } from "./models";

/** omp's tool result is `{ content, details }`; a result without `details` has no glob details. */
const GlobResultEnvelopeSchema = z.looseObject({
  content: z.array(z.unknown()),
  details: z.unknown().optional(),
});

export function GlobCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const state = normalizeToolRendererProps(rendererProps);
  const args = decodeGlobArgs(rendererProps.args);
  const result = state.result ?? state.partialResult;
  const envelope = GlobResultEnvelopeSchema.safeParse(result);
  const details = decodeGlobDetails(envelope.success ? envelope.data.details : result);
  const parsedDetails = details.ok ? details.value : undefined;
  const rawResult = rawText(state.result ?? state.partialResult);
  const summary = globSummary(
    args.ok ? args.value : undefined,
    parsedDetails,
    state.phase,
    rendererProps.args,
  );
  const hideRawDetails =
    "[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden";
  const files = parsedDetails?.files ?? [];
  const shownFiles = files.slice(0, 100);
  const totalFiles = parsedDetails?.fileCount ?? files.length;

  return (
    <div data-testid={`t2-glob-card-${state.toolCallId}`}>
      <ToolCard className={hideRawDetails} rawResult={rawResult} state={state} summary={summary}>
        <div className="py-2 text-sm">
          {args.ok && (
            <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {patternFromArgs(rendererProps.args) && (
                <span data-testid="t2-glob-pattern">
                  Pattern: {patternFromArgs(rendererProps.args)}
                </span>
              )}
              <span>Scope: {args.value.path ?? "workspace"}</span>
              {parsedDetails?.resultLimitReached && args.value.limit !== undefined && (
                <span>Limit: {args.value.limit}</span>
              )}
              {args.value.hidden === true && <span>Hidden files included</span>}
              {args.value.gitignore === false && <span>.gitignore disabled</span>}
            </div>
          )}
          {shownFiles.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2" data-testid="t2-glob-files">
              {shownFiles.map((target) => {
                return (
                  <a
                    className="border-border bg-muted/40 hover:bg-muted focus-visible:ring-ring max-w-full truncate rounded-md border px-2 py-1 text-xs underline-offset-2 hover:underline focus-visible:ring-2"
                    data-read-path={target}
                    href={`#read:${encodeURIComponent(target)}`}
                    key={target}
                    title={`Read ${target}`}
                  >
                    {target}
                  </a>
                );
              })}
              {totalFiles > shownFiles.length && (
                <span className="text-muted-foreground self-center text-xs">
                  Showing {shownFiles.length} of {totalFiles} (+{totalFiles - shownFiles.length}{" "}
                  more)
                </span>
              )}
            </div>
          ) : (
            !state.isError &&
            parsedDetails &&
            parsedDetails.timedOut !== true && (
              <p className="text-muted-foreground mt-3 text-xs">No matches.</p>
            )
          )}
          {parsedDetails?.missingPaths && parsedDetails.missingPaths.length > 0 && (
            <p className="text-warning mt-3 text-xs" data-testid="t2-glob-missing">
              Missing paths: {parsedDetails.missingPaths.join(", ")}
            </p>
          )}
          {parsedDetails?.resultLimitReached && (
            <p className="text-warning mt-3 text-xs" data-testid="t2-glob-limit">
              Results truncated at the requested limit ({totalFiles} found).
            </p>
          )}
          {parsedDetails?.timedOut && (
            <p className="text-warning mt-3 text-xs" data-testid="t2-glob-timed-out">
              The scan timed out before it finished: this list is incomplete and is not proof that
              nothing matches.
            </p>
          )}
          {parsedDetails?.truncated &&
            !parsedDetails.resultLimitReached &&
            parsedDetails.timedOut !== true && (
              <p className="text-warning mt-3 text-xs" data-testid="t2-glob-truncated">
                Scan output was truncated; expand raw details for the recorded result.
              </p>
            )}
          {parsedDetails?.error && (
            <p className="text-destructive mt-3 text-xs" role="alert">
              {parsedDetails.error}
            </p>
          )}
          {!details.ok &&
            result !== undefined &&
            state.phase !== "running" &&
            state.phase !== "partial" && (
              <p className="text-destructive mt-3 text-xs" role="alert">
                Glob details were malformed; the raw result remains available in Raw details.
              </p>
            )}
          {rawResult && (
            <details className="mt-3 text-xs" data-testid="t2-glob-raw-details">
              <summary className="cursor-pointer text-muted-foreground">Raw details</summary>
              <pre className="text-foreground mt-2 max-h-64 overflow-auto whitespace-pre-wrap">
                {rawResult}
              </pre>
            </details>
          )}
        </div>
      </ToolCard>
    </div>
  );
}

export const GlobToolRenderer: ToolRenderer = (props) => <GlobCard rendererProps={props} />;

function globSummary(
  args: { readonly path?: string; readonly limit?: number } | undefined,
  details: GlobToolDetails | undefined,
  phase: string,
  rawArgs: unknown,
): string {
  const scope = args?.path ?? details?.scopePath ?? "workspace";
  const pattern = patternFromArgs(rawArgs);
  const label = pattern === undefined ? scope : `${pattern} · ${scope}`;
  if (phase === "running") return `Scanning ${label}`;
  if (details?.fileCount !== undefined) {
    return `${details.fileCount} match${details.fileCount === 1 ? "" : "es"} · ${label}`;
  }
  return label;
}

function patternFromArgs(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pattern = (value as Record<string, unknown>).pattern;
  return typeof pattern === "string" && pattern.length > 0 ? pattern : undefined;
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[Unserializable glob result]";
  }
}
