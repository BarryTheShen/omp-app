import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { detailsSource } from "../U3/tool-card/result";
import {
  type AstEditFileReplacement,
  type AstEditToolDetails,
  decodeAstEditArgs,
  decodeAstEditDetails,
} from "./models";

interface FileReplacementView {
  readonly path: string;
  readonly count: number;
}

export function AstEditCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const state = normalizeToolRendererProps(rendererProps);
  const args = decodeAstEditArgs(rendererProps.args);
  const output = state.result ?? state.partialResult;
  const details = decodeAstEditDetails(detailsSource(output));
  const parsedDetails = details.ok ? details.value : undefined;
  const stateForCard =
    state.phase === "running" || state.phase === "partial" ? { ...state, argsText: "" } : state;
  const summary = summaryText(parsedDetails, state.phase);
  const replacements = parsedDetails === undefined ? [] : replacementViews(parsedDetails);
  const rawResult = rawText(output);

  return (
    <div data-testid={`t1-ast-edit-card-${state.toolCallId}`}>
      <ToolCard
        className={
          state.phase === "running" || state.phase === "partial"
            ? "[&_[data-slot='u3-tool-card-args']]:hidden"
            : undefined
        }
        rawResult={rawResult}
        state={stateForCard}
        summary={summary}
      >
        {args.ok && (
          <div className="text-sm">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span data-testid="t1-ast-edit-pattern">
                Pattern: {formatPattern(args.value.ops)}
              </span>
              <span>Scope: {args.value.paths.join(", ") || "workspace"}</span>
            </div>
            {replacements.length > 0 && (
              <div className="mt-3 flex flex-col gap-1" data-testid="t1-ast-edit-replacements">
                {replacements.map((replacement) => (
                  <div
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                    data-testid="t1-ast-edit-replacement"
                    key={replacement.path}
                  >
                    <span className="min-w-0 truncate font-mono text-xs" title={replacement.path}>
                      {replacement.path}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {replacement.count} replacement{replacement.count === 1 ? "" : "s"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {parsedDetails?.displayContent && parsedDetails.displayContent.length > 0 && (
              <pre
                className="bg-muted/40 mt-3 overflow-x-auto rounded p-2 font-mono text-xs whitespace-pre-wrap"
                data-testid="t1-ast-edit-preview"
              >
                {parsedDetails.displayContent}
              </pre>
            )}
            {parsedDetails?.parseErrors && parsedDetails.parseErrors.length > 0 && (
              <div
                className="border-danger/40 bg-danger-surface/30 text-danger mt-3 rounded-md border p-2 text-xs"
                role="alert"
              >
                <p className="font-medium">
                  Parse errors (
                  {Math.max(parsedDetails.parseErrorsTotal ?? 0, parsedDetails.parseErrors.length)})
                </p>
                <ul className="mt-1 list-disc ps-4">
                  {parsedDetails.parseErrors.slice(0, 8).map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            )}
            {parsedDetails?.limitReached && (
              <p className="text-muted-foreground mt-3 text-xs" data-testid="t1-ast-edit-limit">
                Match list truncated by a safety limit; some files may not be shown.
              </p>
            )}
            {!details.ok &&
              output !== undefined &&
              state.phase !== "running" &&
              state.phase !== "partial" && (
                <p className="text-danger mt-3 text-xs" role="alert">
                  Structured AST edit details were malformed; the raw result is preserved above.
                </p>
              )}
          </div>
        )}
      </ToolCard>
    </div>
  );
}

export const AstEditToolRenderer: ToolRenderer = (props) => <AstEditCard rendererProps={props} />;

function summaryText(details: AstEditToolDetails | undefined, phase: string): string {
  if (phase === "error") return "Structural edit failed";
  if (details === undefined)
    return phase === "running" ? "Scanning structural matches" : "Raw result";
  const replacements = details.totalReplacements ?? 0;
  const files = details.filesTouched ?? details.files?.length ?? 0;
  const searched = details.filesSearched;
  const counts = `${replacements} replacement${replacements === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}`;
  return searched === undefined ? counts : `${counts} · searched ${searched}`;
}

function replacementViews(details: AstEditToolDetails): readonly FileReplacementView[] {
  return (details.fileReplacements ?? [])
    .slice(0, details.limitReached ? 20 : 100)
    .map(({ path, count }: AstEditFileReplacement) => ({ path, count }));
}

function formatPattern(ops: readonly { readonly pat: string; readonly out: string }[]): string {
  const first = ops[0];
  if (first === undefined) return "(none)";
  return `${first.pat} → ${first.out}${ops.length > 1 ? ` (+${ops.length - 1} more)` : ""}`;
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[Unserializable AST edit result]";
  }
}
