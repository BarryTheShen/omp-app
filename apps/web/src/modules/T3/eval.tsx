import { useMemo } from "react";
import { ToolCard } from "../U3/tool-card/card";
import type {
  OutputMeta,
  ToolCardPhase,
  ToolCardState,
  ToolRenderer,
  ToolRendererProps,
} from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import {
  type EvalArgs,
  type EvalCell,
  type EvalDetails,
  mapT3Failure,
  normalizeEval,
} from "./models";

const MAX_CELLS = 128;
const MAX_OUTPUT_ITEMS = 128;
const MAX_STATUS_EVENTS = 64;
const MAX_TEXT = 8_000;

type EvalModel = ReturnType<typeof normalizeEval>;

export interface EvalCardProps {
  readonly rendererProps: ToolRendererProps<EvalArgs, unknown>;
}

/** Render-only eval card: runtime data arrives through U3/R0; this component never executes code. */
export function EvalCard({ rendererProps }: EvalCardProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const model = useMemo(
    () => normalizeEval(rendererProps.args, rendererProps.result ?? normalized.result),
    [normalized.result, rendererProps.args, rendererProps.result],
  );
  const details = model.details;
  const imagesFromContent = resultImages(model.raw);
  const phase = phaseFor(normalized, details, model.malformed);
  const outputMeta = outputMetaFor(details, normalized.outputMeta);
  const state = evalState(normalized, model, phase, outputMeta);
  const language = languageFor(rendererProps.args, details);

  return (
    <div data-slot="t3-eval-card" data-testid={`t3-eval-card-${normalized.toolCallId}`}>
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
        state={state}
        summary={summaryFor(language, details, state.phase)}
      >
        <div className="flex min-w-0 flex-col gap-3 py-2" data-slot="t3-eval-details">
          <EvalHeader details={details} language={language} />
          <EvalCells
            cells={details?.cells}
            fallbackCode={argsCode(rendererProps.args)}
            language={language}
          />
          <EvalStatus details={details} />
          <EvalAsyncJob details={details} />
          <EvalStructuredOutputs details={details} contentImages={imagesFromContent} />
          <EvalErrorDetails details={details} />
          <details className="text-muted-foreground text-xs" data-testid="t3-eval-raw-details">
            <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Raw details
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap">
              {boundedText(model.raw)}
            </pre>
          </details>
        </div>
      </ToolCard>
    </div>
  );
}

/** Assistant-ui renderer entry used by T3's descriptor. */
export const EvalToolRenderer: ToolRenderer<EvalArgs, unknown> = (props) => (
  <EvalCard rendererProps={props} />
);

function evalState(
  normalized: ToolCardState,
  model: EvalModel,
  phase: ToolCardPhase,
  outputMeta: OutputMeta | undefined,
): ToolCardState {
  const failure = failureFor(model, phase, normalized.error?.message);
  return {
    ...normalized,
    phase,
    result: undefined,
    partialResult: undefined,
    isError: phase === "error",
    ...(failure === undefined ? {} : { error: failure }),
    ...(phase === "cancelled" ? { cancelled: true } : {}),
    outputMeta,
  };
}

function failureFor(
  model: EvalModel,
  phase: ToolCardPhase,
  reason: string | undefined,
): ToolCardState["error"] | undefined {
  if (phase === "cancelled") {
    return { code: "cancelled", message: "Evaluation cancelled.", retryable: false };
  }
  if (model.malformed) {
    return {
      code: "invalid_args",
      message: "Evaluation details were malformed; raw output is retained.",
      retryable: false,
    };
  }
  if (phase !== "error") return undefined;
  const rawError = detailsRecord(model.details)?.error;
  const errorRecord = asRecord(rawError);
  const message =
    typeof rawError === "string"
      ? safeText(rawError)
      : typeof errorRecord?.message === "string"
        ? safeText(errorRecord.message)
        : undefined;
  if (message !== undefined && message.length > 0) {
    return { code: "omp_error", message, retryable: false };
  }
  if (rawError === undefined) {
    // omp's words for the failure are in the result's text. When a cell already shows them as its
    // output, the banner stays short; otherwise (a run that never started) the banner carries them.
    const cellsShowIt = model.details?.cells?.some(
      (cell) => typeof cell.output === "string" && cell.output.length > 0,
    );
    return {
      message:
        cellsShowIt === true || reason === undefined ? "Evaluation reported an error." : reason,
      retryable: false,
    };
  }
  const failure = mapT3Failure(rawError, "eval");
  return {
    code: failure.appError.code,
    message: failure.appError.message,
    retryable: failure.appError.retryable,
    timeout: failure.appError.code === "timeout",
  };
}

function phaseFor(
  normalized: ToolCardState,
  details: EvalDetails | undefined,
  malformed: boolean,
): ToolCardPhase {
  if (normalized.phase === "cancelled") return "cancelled";
  if (malformed || normalized.phase === "error") return "error";
  if (details?.isError === true || details?.async?.state === "failed") return "error";
  if (details?.cells?.some((cell) => cell.status === "error")) return "error";
  if (
    normalized.phase === "success" &&
    (details?.async?.state === "running" ||
      details?.cells?.some((cell) => cell.status === "running" || cell.status === "pending"))
  ) {
    return "partial";
  }
  return normalized.phase;
}

function outputMetaFor(
  details: EvalDetails | undefined,
  existing: OutputMeta | undefined,
): OutputMeta | undefined {
  const meta = detailsRecord(details)?.meta;
  if (meta === undefined || typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return existing;
  }
  return { ...existing, ...(meta as OutputMeta) };
}

function detailsRecord(details: EvalDetails | undefined): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  return details as unknown as Record<string, unknown>;
}

function languageFor(args: unknown, details: EvalDetails | undefined): string {
  if (details?.language !== undefined && details.language.length > 0) return details.language;
  if (details?.languages?.[0] !== undefined) return details.languages[0];
  const parsed = argsRecord(args)?.language;
  return typeof parsed === "string" && parsed.length > 0 ? parsed : "text";
}

function argsCode(args: unknown): string | undefined {
  const code = argsRecord(args)?.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function argsRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function summaryFor(
  language: string,
  details: EvalDetails | undefined,
  phase: ToolCardPhase,
): string {
  const cells = details?.cells?.length ?? 0;
  const asyncState = details?.async?.state;
  const suffix = asyncState === undefined ? "" : ` · job ${asyncState}`;
  return `${language}${cells > 0 ? ` · ${cells} cell${cells === 1 ? "" : "s"}` : ""}${suffix} · ${phase}`;
}

function EvalHeader({
  details,
  language,
}: {
  readonly details: EvalDetails | undefined;
  readonly language: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="t3-eval-header">
      <span
        className="border-border bg-muted text-muted-foreground rounded border px-2 py-0.5 font-mono text-xs"
        data-eval-language
      >
        {language}
      </span>
      {details?.notice !== undefined && (
        <span className="text-muted-foreground min-w-0 text-xs">{safeText(details.notice)}</span>
      )}
    </div>
  );
}

function EvalCells({
  cells,
  fallbackCode,
  language,
}: {
  readonly cells: readonly EvalCell[] | undefined;
  readonly fallbackCode: string | undefined;
  readonly language: string;
}) {
  const visible = cells?.slice(0, MAX_CELLS) ?? [];
  if (visible.length === 0 && fallbackCode === undefined) return null;
  const fallback: EvalCell | undefined =
    visible.length === 0 && fallbackCode !== undefined
      ? { index: 0, code: fallbackCode, language, status: "pending" }
      : undefined;
  const items = fallback === undefined ? visible : [fallback];
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="t3-eval-cells">
      {items.map((cell) => (
        <EvalCellView
          cell={cell}
          key={`${cell.index ?? "cell"}:${cell.code ?? ""}`}
          language={language}
        />
      ))}
      {cells !== undefined && cells.length > MAX_CELLS && (
        <span className="text-muted-foreground text-xs">
          Showing {visible.length} of {cells.length} cells.
        </span>
      )}
    </div>
  );
}

function EvalCellView({ cell, language }: { readonly cell: EvalCell; readonly language: string }) {
  const cellLanguage = cell.language ?? language;
  const output = cell.output;
  return (
    <article
      className="min-w-0 py-2"
      data-cell-status={cell.status ?? "pending"}
      data-testid={`t3-eval-cell-${cell.index ?? "unknown"}`}
    >
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs">
        <span className="text-muted-foreground font-mono" data-cell-language>
          {cellLanguage}
        </span>
      </div>
      {cell.code !== undefined && (
        <pre className="max-h-72 overflow-auto px-2 py-2 text-xs leading-relaxed" data-cell-code>
          <code className={`language-${safeLanguage(cellLanguage)}`}>{boundedText(cell.code)}</code>
        </pre>
      )}
      {output !== undefined && <CellOutput output={output} />}
      {(cell.durationMs !== undefined || cell.exitCode !== undefined) && (
        <div className="text-muted-foreground px-2 py-1 text-xs">
          {cell.durationMs !== undefined && `${cell.durationMs} ms`}
          {cell.durationMs !== undefined && cell.exitCode !== undefined && " · "}
          {cell.exitCode !== undefined && `exit ${cell.exitCode}`}
        </div>
      )}
    </article>
  );
}

function CellOutput({ output }: { readonly output: unknown }) {
  const items = Array.isArray(output) ? output.slice(0, MAX_OUTPUT_ITEMS) : [output];
  return (
    <div className="px-2 py-2" data-cell-output>
      {items.map((item) => {
        const image = imageSource(item);
        const outputKey = outputText(item).slice(0, 96);
        if (image !== undefined) {
          return (
            <img
              alt="Evaluation result"
              className="border-border/70 h-auto max-h-72 w-72 max-w-full rounded border bg-muted p-1 object-contain"
              key={`image-${image}`}
              src={image}
            />
          );
        }
        return (
          <pre
            className="text-muted-foreground max-h-72 overflow-auto whitespace-pre-wrap text-xs"
            key={`output-${outputKey}`}
          >
            {boundedText(outputText(item))}
          </pre>
        );
      })}
    </div>
  );
}

function EvalStatus({ details }: { readonly details: EvalDetails | undefined }) {
  const events = details?.statusEvents?.slice(0, MAX_STATUS_EVENTS) ?? [];
  if (events.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="t3-eval-status-events">
      {events.map((event) => (
        <div className="text-muted-foreground truncate text-xs" key={statusEventText(event)}>
          {statusEventText(event)}
        </div>
      ))}
    </div>
  );
}
function EvalAsyncJob({ details }: { readonly details: EvalDetails | undefined }) {
  const job = details?.async;
  if (job === undefined) return null;
  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-2 px-2 text-xs"
      data-testid="t3-eval-async-job"
    >
      <span className="font-medium text-foreground">Async job</span>
      <span>{job.state ?? "unknown"}</span>
      {job.jobId !== undefined && <code>{safeText(job.jobId)}</code>}
    </div>
  );
}

function EvalStructuredOutputs({
  details,
  contentImages,
}: {
  readonly details: EvalDetails | undefined;
  readonly contentImages: readonly unknown[];
}) {
  const jsonOutputs = details?.jsonOutputs?.slice(0, MAX_OUTPUT_ITEMS) ?? [];
  const seenImages = new Set<string>();
  const images = [...(details?.images ?? []), ...contentImages]
    .filter((image) => {
      const source = imageSource(image);
      const identity = source ?? `unavailable-${boundedText(image)}`;
      if (seenImages.has(identity)) return false;
      seenImages.add(identity);
      return true;
    })
    .slice(0, MAX_OUTPUT_ITEMS);
  if (jsonOutputs.length === 0 && images.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="t3-eval-structured-outputs">
      {jsonOutputs.map((output) => (
        <StructuredValue key={`json-${outputText(output).slice(0, 96)}`} value={output} />
      ))}
      {images.map((image) => {
        const source = imageSource(image);
        return source === undefined ? (
          <div
            className="text-muted-foreground text-xs"
            key={`image-unavailable-${boundedText(image)}`}
          >
            Image preview is unavailable.
          </div>
        ) : (
          <img
            alt="Evaluation result"
            className="border-border/70 h-auto max-h-72 w-72 max-w-full rounded border bg-muted p-1 object-contain"
            key={`image-${source}`}
            src={source}
          />
        );
      })}
    </div>
  );
}

function StructuredValue({ value }: { readonly value: unknown }) {
  const object = asRecord(value);
  if (object === undefined) {
    return <div className="text-muted-foreground text-xs">{structuredText(value)}</div>;
  }
  // omp's real JSON output is `{ preview, truncated, totalBytes }`; the value itself is already in
  // the cell's output above, so this says only how big it was.
  if (typeof object.preview === "string" && typeof object.totalBytes === "number") {
    return (
      <div className="text-muted-foreground text-xs" data-testid="t3-eval-json-size">
        Structured result, {object.totalBytes.toLocaleString("en-US")} bytes
        {object.truncated === true ? " (shortened here)" : ""}
      </div>
    );
  }
  const entries = Object.entries(object).slice(0, 32);
  return (
    <dl className="grid min-w-0 gap-1 text-xs" data-testid="t3-eval-json-rows">
      {entries.map(([key, entry]) => (
        <div className="grid min-w-0 grid-cols-[minmax(5rem,auto)_1fr] gap-2" key={key}>
          <dt className="text-muted-foreground truncate">{safeText(key)}</dt>
          <dd className="min-w-0 truncate font-mono">{structuredText(entry)}</dd>
        </div>
      ))}
      {Object.keys(object).length > entries.length && (
        <span className="text-muted-foreground">
          Showing {entries.length} of {Object.keys(object).length}
        </span>
      )}
    </dl>
  );
}

function EvalErrorDetails({ details }: { readonly details: EvalDetails | undefined }) {
  const error = asRecord(detailsRecord(details)?.error);
  const traceback = error?.traceback ?? error?.stack;
  if (typeof traceback !== "string" || traceback.length === 0) return null;
  return (
    <details className="text-muted-foreground text-xs" data-testid="t3-eval-traceback">
      <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Traceback
      </summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">
        {boundedText(traceback)}
      </pre>
    </details>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function structuredText(value: unknown): string {
  if (typeof value === "string") return safeText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  return boundedText(value);
}
function statusEventText(event: unknown): string {
  if (event === null || typeof event !== "object" || Array.isArray(event))
    return boundedText(event);
  const record = event as Record<string, unknown>;
  // omp's real events are `{ op, detail }` (what the cell did: "browser: docs.evaluate(...)"), `{ op, path, chars }`
  // and `{ op, error }`; `{ status, message }` is the older shape.
  const kind =
    typeof record.status === "string"
      ? record.status
      : typeof record.op === "string"
        ? record.op
        : undefined;
  const what =
    typeof record.message === "string"
      ? record.message
      : typeof record.detail === "string"
        ? record.detail
        : typeof record.path === "string"
          ? record.path
          : undefined;
  const failed = typeof record.error === "string" ? record.error : undefined;
  const line = [[kind, what].filter(Boolean).join(": "), failed].filter(Boolean).join(" · ");
  return safeText(line) || boundedText(event);
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (
          item !== null &&
          typeof item === "object" &&
          "text" in item &&
          typeof item.text === "string"
        )
          return item.text;
        return outputText(item);
      })
      .join("\n");
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[unavailable output]";
  }
}

/** omp v18.9.1 `ImageContent` is delivered in eval result content as raw bytes and a MIME type. */
function resultImages(value: unknown): readonly unknown[] {
  const content = asRecord(value)?.content;
  return Array.isArray(content) ? content.filter((item) => asRecord(item)?.type === "image") : [];
}

function imageSource(value: unknown): string | undefined {
  if (typeof value === "string") {
    return /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value) ? value : undefined;
  }
  const image = asRecord(value);
  if (
    image?.type === "image" &&
    typeof image.data === "string" &&
    image.data.length > 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(image.data) &&
    typeof image.mimeType === "string" &&
    /^image\/(?:png|jpeg|gif|webp)$/i.test(image.mimeType)
  ) {
    return `data:${image.mimeType.toLowerCase()};base64,${image.data}`;
  }
  const candidate = image?.image ?? image?.data ?? image?.src;
  return typeof candidate === "string" &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(candidate)
    ? candidate
    : undefined;
}

function safeLanguage(language: string): string {
  return language.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32) || "text";
}

/** Drops control characters (escape sequences, NUL, ...) but keeps tabs and line breaks: code and output are lines. */
function safeText(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code <= 31 && code !== 9 && code !== 10) || code === 127) continue;
    output += character;
    if (output.length >= MAX_TEXT) break;
  }
  return output;
}
function boundedText(value: unknown): string {
  return safeText(outputText(value));
}
