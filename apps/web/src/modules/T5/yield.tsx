import { EmptyState } from "@/components/blocks";
import { ToolCard } from "../U3/tool-card/card";
import type {
  ToolCardError,
  ToolCardPhase,
  ToolCardState,
  ToolRenderer,
  ToolRendererProps,
} from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { detailsSource, splitToolResult } from "../U3/tool-card/result";
import { decodeYieldDetails, type YieldDetails } from "./models";

const MAX_OUTPUT_LINES = 12;
const MAX_OUTPUT_CHARACTERS = 8_000;
const MAX_SECTION_LABELS = 20;
const MAX_ERROR_CHARACTERS = 500;

/**
 * The sources omp writes for a call that a person stopped or a message skipped (agent-loop.ts:3896-3914 and
 * :4024-4026). omp's own card shows them as cancelled. Its other synthetic sources are errors.
 */
const ENDED_BY_SOURCE: ReadonlySet<string> = new Set([
  "assistant_stop_aborted",
  "assistant_stop_skipped",
  "interrupt_skipped",
]);

interface YieldCardProps {
  readonly rendererProps: ToolRendererProps;
}

/** Read-only presentation for a submitted result, shown the way omp's own yield card shows it. */
function YieldCard({ rendererProps }: YieldCardProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const raw = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const decoded = raw === undefined ? undefined : decodeYieldDetails(detailsSource(raw));
  const details = decoded?.ok === true ? decoded.value : undefined;
  const item = workItemNumber(rendererProps.args);
  const text = truncate(splitToolResult(raw).text.trim());
  const state = yieldState(normalized, details, decoded?.ok === false, text);
  const rawResult = raw === undefined ? "" : rawText(raw);

  return (
    <div className="min-w-0" data-slot="t5-yield-card" data-testid="t5-yield-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden max-sm:[&_[data-slot='u3-tool-card-trigger']]:flex-wrap"
        rawResult={rawResult}
        state={state}
        summary={yieldSummary(details, state, item, raw !== undefined)}
      >
        {details !== undefined && reportsSubmission(details) ? (
          <YieldDetailsView details={details} item={item} />
        ) : state.phase === "running" || state.phase === "partial" ? (
          <p className="text-muted-foreground mt-2 text-xs">Waiting for submitted output.</p>
        ) : null}
      </ToolCard>
    </div>
  );
}

/** Assistant-ui renderer entry for the yield tool. */
export const YieldToolRenderer: ToolRenderer = (props) => <YieldCard rendererProps={props} />;

function YieldDetailsView({
  details,
  item,
}: {
  readonly details: YieldDetails;
  readonly item: number | undefined;
}) {
  const labels = sectionLabels(details.type);
  const labelOccurrences = new Map<string, number>();
  const sectionItems = labels.slice(0, MAX_SECTION_LABELS).map((label) => {
    const occurrence = labelOccurrences.get(label) ?? 0;
    labelOccurrences.set(label, occurrence + 1);
    return { label, key: `${label}-${occurrence}` };
  });
  return (
    <section className="flex min-w-0 flex-col gap-3 py-2 text-sm" data-slot="t5-yield-details">
      {/* A workpool item is one of several submissions: its number says which one. Its type is the item's id. */}
      {item !== undefined ? (
        <section data-slot="t5-yield-item">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">{`Item ${item}`}</h3>
        </section>
      ) : labels.length > 0 ? (
        <section data-slot="t5-yield-sections">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            {Array.isArray(details.type) ? "Submitted sections" : "Result type"}
          </h3>
          {Array.isArray(details.type) ? (
            <>
              <ul className="flex flex-wrap gap-1.5 text-xs">
                {sectionItems.map(({ label, key }) => (
                  <li className="bg-muted text-foreground rounded px-2 py-1" key={key}>
                    {label}
                  </li>
                ))}
              </ul>
              {labels.length > MAX_SECTION_LABELS && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {`Showing ${MAX_SECTION_LABELS} of ${labels.length} sections · +${labels.length - MAX_SECTION_LABELS} more`}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-foreground">{labels[0]}</p>
          )}
        </section>
      ) : null}
      {details.useLastTurn === true && (
        <p className="text-xs text-muted-foreground">
          The last assistant response was used as the result.
        </p>
      )}
      {details.complete === true && (
        <p className="text-xs text-muted-foreground">All items were submitted.</p>
      )}
      {details.schemaOverridden === true && (
        <p className="border-warning/40 bg-warning-surface text-warning-surface-foreground rounded border px-3 py-2 text-xs">
          The result was accepted after schema validation was overridden.
        </p>
      )}
      {details.data !== undefined ? (
        <SubmittedData value={details.data} />
      ) : details.status === "success" && details.useLastTurn !== true ? (
        <EmptyState
          hint="This submission did not include result data."
          title="No submitted output"
          variant="compact"
        />
      ) : null}
    </section>
  );
}

function SubmittedData({ value }: { readonly value: unknown }) {
  const raw = typeof value === "string" ? value : rawText(value);
  const preview = outputPreview(raw);
  return (
    <section className="min-w-0" data-slot="t5-yield-output" data-testid="t5-yield-output">
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">Submitted output</h3>
      {raw.length === 0 ? (
        <p className="text-xs text-muted-foreground">An empty text result was submitted.</p>
      ) : (
        <pre className="border-border bg-muted/30 text-foreground max-h-64 min-w-0 overflow-auto rounded border p-2 text-xs whitespace-pre-wrap break-words">
          {preview.text}
        </pre>
      )}
      {preview.truncated && (
        <p className="mt-1 text-xs text-muted-foreground">
          {`Showing ${preview.shownLines} of ${preview.totalLines} lines; ${preview.omittedCharacters} characters omitted. The full output is in Raw details.`}
        </p>
      )}
    </section>
  );
}

function reportsSubmission(details: YieldDetails): boolean {
  // An error or a skipped call reports no submission: its banner says what happened, and no body is drawn for it.
  return (
    details.status === "success" ||
    details.status === "aborted" ||
    details.data !== undefined ||
    details.type !== undefined ||
    details.useLastTurn === true ||
    details.complete === true ||
    details.schemaOverridden === true
  );
}

function yieldState(
  normalized: ToolCardState,
  details: YieldDetails | undefined,
  decodeError: boolean,
  text: string,
): ToolCardState {
  const decodeMessage = decodeError ? "The result is invalid; raw output is available." : undefined;
  const resultError = submissionError(details?.error);
  const aborted = details?.status === "aborted";
  const endedEarly = normalized.phase === "cancelled" || endedBySource(details);
  const failed =
    decodeMessage !== undefined ||
    resultError !== undefined ||
    aborted ||
    normalized.phase === "error";
  const phase: ToolCardPhase = endedEarly ? "cancelled" : failed ? "error" : normalized.phase;
  // A cancelled or failed call says why: omp's own words (its result text) when it gives no other reason.
  const reason =
    decodeMessage ??
    resultError ??
    normalized.error?.message ??
    (text.length > 0 ? text : undefined) ??
    (aborted ? "Aborted" : undefined);
  const error: ToolCardError | undefined =
    (endedEarly || failed) && reason !== undefined
      ? {
          ...(normalized.error ?? {}),
          ...(decodeMessage === undefined ? {} : { code: "invalid_args" }),
          message: reason,
          retryable: normalized.error?.retryable ?? false,
        }
      : normalized.error;
  return {
    ...normalized,
    label: "Submission",
    phase,
    isError: phase === "error",
    ...(phase === "cancelled" ? { cancelled: true } : {}),
    ...(error === undefined ? {} : { error }),
    result: undefined,
    partialResult: undefined,
  };
}

function yieldSummary(
  details: YieldDetails | undefined,
  state: ToolCardState,
  item: number | undefined,
  hasRawResult: boolean,
): string {
  if (state.phase === "running") return "Submitting output";
  if (state.phase === "partial") return "Submission in progress";
  if (state.phase === "cancelled") return "Submission ended early";
  if (state.phase === "error") return "Submission failed";
  if (details?.schemaOverridden === true) return "Accepted after validation override";
  if (details?.complete === true) return "All items submitted";
  if (item !== undefined) return `Item ${item} submitted`;
  if (details?.useLastTurn === true) return "Uses the last assistant response";
  if (Array.isArray(details?.type)) {
    const count = sectionLabels(details.type).length;
    return `${count} section${count === 1 ? "" : "s"} submitted`;
  }
  if (typeof details?.type === "string" && details.type.length > 0) {
    return `${oneLine(details.type)} submitted`;
  }
  if (details?.data !== undefined) return "Result submitted";
  if (details !== undefined) return "No result data submitted";
  return hasRawResult ? "Raw submission result" : "Waiting for submission";
}

/** The workpool item a call submitted: its `key` argument (yield.ts:225-245), when the call has one. */
function workItemNumber(args: unknown): number | undefined {
  return typeof args === "object" && args !== null && "key" in args && typeof args.key === "number"
    ? args.key
    : undefined;
}

/** A person's Stop, or a call a message skipped: cancelled, not an error (see ENDED_BY_SOURCE). */
function endedBySource(details: YieldDetails | undefined): boolean {
  if (details === undefined) return false;
  return (
    details.__interrupted === true ||
    (details.source !== undefined && ENDED_BY_SOURCE.has(details.source))
  );
}

function sectionLabels(type: YieldDetails["type"]): readonly string[] {
  const values = typeof type === "string" ? [type] : (type ?? []);
  return values.filter((value) => value.trim().length > 0);
}

function submissionError(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().length === 0 ? undefined : truncate(value);
  if (value === undefined || value === null) return undefined;
  return "The submission returned an invalid error.";
}

function outputPreview(raw: string): {
  readonly text: string;
  readonly totalLines: number;
  readonly shownLines: number;
  readonly omittedCharacters: number;
  readonly truncated: boolean;
} {
  const lines = raw.split(/\r?\n/);
  const text = lines.slice(0, MAX_OUTPUT_LINES).join("\n").slice(0, MAX_OUTPUT_CHARACTERS);
  const shownLines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  return {
    text,
    totalLines: lines.length,
    shownLines,
    omittedCharacters: Math.max(0, raw.length - text.length),
    truncated: text.length < raw.length,
  };
}

function rawText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[Unserializable result]";
  }
}

function oneLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}…` : normalized;
}

function truncate(value: string): string {
  return value.length > MAX_ERROR_CHARACTERS
    ? `${value.slice(0, MAX_ERROR_CHARACTERS - 1)}…`
    : value;
}
