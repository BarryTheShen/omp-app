import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { detailsSource } from "../U3/tool-card/result";
import { type AstEditToolDetails, decodeAstEditArgs, decodeAstEditDetails } from "./models";

interface ReplacementView {
  readonly path: string;
  readonly before: string;
  readonly after: string;
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
      />
      {args.ok && (
        <div className="border-border/70 bg-muted/20 mt-1 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span data-testid="t1-ast-edit-pattern">Pattern: {formatPattern(args.value.ops)}</span>
            <span>Scope: {args.value.paths.join(", ") || "workspace"}</span>
          </div>
          {replacements.length > 0 && (
            <div className="mt-3 flex flex-col gap-3" data-testid="t1-ast-edit-replacements">
              {replacements.map((replacement, index) => (
                <div
                  className="border-border/70 min-w-0 rounded-md border p-2"
                  data-testid={`t1-ast-edit-replacement-${index}`}
                  key={`${replacement.path}:${replacement.before}:${replacement.after}`}
                >
                  <p className="truncate text-xs font-medium" title={replacement.path}>
                    {replacement.path}
                  </p>
                  <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
                    <pre className="bg-destructive/10 text-destructive min-w-0 overflow-x-auto rounded p-2 text-xs whitespace-pre-wrap">
                      {replacement.before || "(no before text)"}
                    </pre>
                    <pre className="bg-success/10 text-success min-w-0 overflow-x-auto rounded p-2 text-xs whitespace-pre-wrap">
                      {replacement.after || "(no replacement text)"}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          )}
          {parsedDetails?.parseErrors && parsedDetails.parseErrors.length > 0 && (
            <div
              className="border-danger/40 bg-danger-surface/30 text-danger mt-3 rounded-md border p-2 text-xs"
              role="alert"
            >
              <p className="font-medium">Parse errors ({parsedDetails.parseErrors.length})</p>
              <ul className="mt-1 list-disc ps-4">
                {parsedDetails.parseErrors.slice(0, 8).map((error) => {
                  const parsed = parseError(error);
                  return (
                    <li key={JSON.stringify(error)}>
                      {parsed.path ? (
                        <a
                          className="text-primary underline underline-offset-2"
                          data-read-path={parsed.path}
                          href={`#read:${encodeURIComponent(parsed.path)}`}
                          title={`Read ${parsed.path}`}
                        >
                          {parsed.path}
                        </a>
                      ) : (
                        <span>AST edit</span>
                      )}
                      {parsed.location && `:${parsed.location}`}: {parsed.message}
                    </li>
                  );
                })}
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
    </div>
  );
}

export const AstEditToolRenderer: ToolRenderer = (props) => <AstEditCard rendererProps={props} />;

function summaryText(details: AstEditToolDetails | undefined, phase: string): string {
  if (details === undefined)
    return phase === "running" ? "Scanning structural matches" : "Raw result";
  const replacements = details.totalReplacements ?? 0;
  const files = details.filesTouched ?? details.files?.length ?? 0;
  const searched = details.filesSearched;
  const counts = `${replacements} replacement${replacements === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}`;
  return searched === undefined ? counts : `${counts} · searched ${searched}`;
}

function replacementViews(details: AstEditToolDetails): readonly ReplacementView[] {
  const files = details.fileReplacements ?? [];
  return files.slice(0, details.limitReached ? 20 : 100).map((file, index) => {
    const path = stringValue(file.path) ?? details.files?.[index] ?? `match ${index + 1}`;
    const before =
      stringValue(file.before) ?? stringValue(file.oldText) ?? stringValue(file.pattern) ?? "";
    const after =
      stringValue(file.after) ?? stringValue(file.newText) ?? stringValue(file.replacement) ?? "";
    return { path, before, after };
  });
}

function formatPattern(ops: readonly { readonly pat: string; readonly out: string }[]): string {
  const first = ops[0];
  if (first === undefined) return "(none)";
  return `${first.pat} → ${first.out}${ops.length > 1 ? ` (+${ops.length - 1} more)` : ""}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function parseError(value: unknown): {
  readonly path?: string;
  readonly location?: string;
  readonly message: string;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { message: String(value) };
  }
  const record = value as Record<string, unknown>;
  const path = stringValue(record.path) ?? stringValue(record.file);
  const line = numberOrText(record.line) ?? numberOrText(record.startLine);
  const column = numberOrText(record.column) ?? numberOrText(record.startColumn);
  const location =
    line === undefined ? undefined : `${line}${column === undefined ? "" : `:${column}`}`;
  return {
    ...(path === undefined ? {} : { path }),
    ...(location === undefined ? {} : { location }),
    message:
      stringValue(record.message) ??
      stringValue(record.error) ??
      "AST parsing failed for this match.",
  };
}

function numberOrText(value: unknown): string | undefined {
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
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
