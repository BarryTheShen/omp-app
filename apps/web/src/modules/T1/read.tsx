import { Button } from "../../components/ui/button";
import { Icons } from "../../tokens";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { omittedOf, type TruncationMeta } from "../U3/tool-card/output-meta";
import { splitToolResult } from "../U3/tool-card/result";
import { TextOutput } from "../U3/tool-card/text-output";
import { decodeReadArgs, decodeReadDetails, type ReadToolDetails } from "./models";
import { dispatchReadUrl, type ReadUrlRenderer } from "./read-url-seam";

export interface ReadGroupItem {
  readonly toolCallId: string;
  readonly details: ReadToolDetails;
}

export interface ReadCardProps {
  readonly rendererProps: ToolRendererProps;
  readonly urlRenderer?: ReadUrlRenderer;
  readonly groupedReads?: readonly ReadGroupItem[];
}

/** Renders one normalized read call and hands URL-shaped details to T4 without fetching them. */
export function ReadCard({ rendererProps, urlRenderer, groupedReads }: ReadCardProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const args = decodeReadArgs(rendererProps.args);
  const detailSource = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const rawResult = rawText(detailSource);
  // omp's result is `{ content, details }`: the details are decoded, the text is the fallback.
  const split = splitToolResult(detailSource);
  const details = detailSource === undefined ? undefined : decodeReadDetails(split.details ?? {});
  // A failed read is its error banner (omp's own words); a body under it would say the same again.
  if (details === undefined || normalized.phase === "error") {
    return (
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawResult}
        state={{
          ...normalized,
          result: undefined,
          partialResult: undefined,
        }}
        summary={displayTarget(args.ok ? args.value : undefined, undefined)}
      />
    );
  }
  if (!details.ok && (normalized.phase === "running" || normalized.phase === "partial")) {
    return (
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawResult}
        state={{
          ...normalized,
          result: undefined,
          partialResult: undefined,
        }}
        summary={displayTarget(args.ok ? args.value : undefined, undefined)}
      />
    );
  }
  if (!details.ok) {
    return (
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawResult}
        state={{
          ...normalized,
          phase: "error",
          isError: true,
          error: {
            code: "invalid_args",
            message: details.error.appError.message,
            retryable: false,
          },
          defaultOpen: true,
          result: undefined,
          partialResult: undefined,
        }}
        summary="Read result unavailable"
      />
    );
  }

  if (details.value.kind === "url") {
    const dispatched = dispatchReadUrl(
      {
        toolCallId: normalized.toolCallId,
        rendererProps,
        details: details.value,
        rawArgs: normalized.argsText,
        rawResult,
        text: split.text,
      },
      urlRenderer,
    );
    if (dispatched !== null) return dispatched;
  }

  const target = displayTarget(args.ok ? args.value : undefined, details.value);
  const state = {
    ...normalized,
    result: undefined,
    partialResult: undefined,
    defaultOpen: normalized.defaultOpen,
  };
  return (
    <div data-slot="t1-read-card" data-testid="t1-read-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawResult}
        state={state}
        summary={middleEllipsis(target)}
      />
      <ReadBody
        args={args.ok ? args.value : undefined}
        details={details.value}
        fallbackText={split.text}
        groupedReads={groupedReads}
        target={target}
        urlAvailable={details.value.kind !== "url" || urlRenderer !== undefined}
      />
    </div>
  );
}

/**
 * A read renderer whose URL reads go to `urlRenderer` (T4 implements it; the composition root injects
 * it, so T1 never imports T4). Without one, URL reads say the renderer is unavailable.
 */
export function createReadToolRenderer(urlRenderer?: ReadUrlRenderer): ToolRenderer {
  return (props) => <ReadCard rendererProps={props} urlRenderer={urlRenderer} />;
}

/** Descriptor renderer entry; the composition root swaps in the URL-aware one. */
export const ReadToolRenderer: ToolRenderer = createReadToolRenderer();

function ReadBody({
  args,
  details,
  fallbackText,
  groupedReads,
  target,
  urlAvailable,
}: {
  readonly args?: { readonly offset?: number; readonly limit?: number };
  readonly details: ReadToolDetails;
  /** The text omp returned; shown when the details hold no lines to display (a directory, a database, a summary). */
  readonly fallbackText: string;
  readonly groupedReads?: readonly ReadGroupItem[];
  readonly target: string;
  readonly urlAvailable: boolean;
}) {
  const selector = selectorText(args, details);
  const content = details.displayContent?.text;
  const mimeType = contentTypeFor(details);
  const isImage = mimeType?.startsWith("image/") === true;
  const isBinary = binaryContentFor(details, mimeType);
  const imageSource = imageSourceFor(details);
  const notes = details.notes
    ?.slice(0, 4)
    .map((note) => middleEllipsis(note, 240))
    .join(" · ");
  const diagnostics = diagnosticMessages(details);
  return (
    <section
      className="ms-2 flex min-w-0 flex-col gap-2 border-s-2 border-border/70 py-2 ps-4"
      data-slot="t1-read-body"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono" title={target}>
          {middleEllipsis(target)}
        </span>
        {selector && <span className="rounded border border-border px-2 py-0.5">{selector}</span>}
        {details.kind === "url" && (
          <span className="rounded border border-border px-2 py-0.5">
            {urlAvailable ? "URL read" : "URL renderer unavailable"}
          </span>
        )}
        {groupedReads && groupedReads.length > 1 && (
          <span className="rounded border border-border px-2 py-0.5">
            {groupedReads.length} reads grouped
          </span>
        )}
      </div>
      {details.isDirectory ? (
        <div className="border-border bg-muted/40 rounded-lg border p-3 text-sm">
          <p>Directory listing</p>
          {fallbackText !== "" && <TextOutput text={fallbackText} testId="t1-read-text" />}
        </div>
      ) : imageSource !== undefined ? (
        <div className="border-border bg-muted/30 flex items-center justify-center rounded-lg border p-3">
          <img alt={target} className="max-h-64 max-w-full object-contain" src={imageSource} />
        </div>
      ) : isImage ? (
        <div className="border-border bg-muted/30 flex min-h-24 items-center justify-center rounded-lg border p-3 text-sm text-muted-foreground">
          Image preview supplied by the read result.
        </div>
      ) : isBinary ? (
        <div
          className="border-border bg-muted/40 rounded-lg border p-3 text-sm text-muted-foreground"
          data-testid="t1-read-binary"
        >
          Binary content
          {mimeType && ` (${mimeType})`} preview is unavailable.
          {details.fileSize !== undefined && ` ${details.fileSize} bytes.`}
        </div>
      ) : content !== undefined ? (
        <CodePreview
          content={content}
          lineNumbers={
            Array.isArray(details.displayContent?.lineNumbers)
              ? details.displayContent.lineNumbers
              : undefined
          }
          startLine={details.displayContent?.startLine ?? 1}
          target={target}
        />
      ) : details.summary === undefined && fallbackText !== "" ? (
        <div className="border-border bg-muted/40 rounded-lg border p-3 text-sm">
          <TextOutput text={fallbackText} testId="t1-read-text" />
        </div>
      ) : (
        <div className="border-border bg-muted/40 rounded-lg border p-3 text-sm text-muted-foreground">
          {details.summary === undefined
            ? "No displayable content"
            : `${details.summary.lines} lines shown; ${details.summary.elidedLines} lines in ${details.summary.elidedSpans} omitted spans.`}
        </div>
      )}
      {details.suffixResolution && (
        <p className="text-xs text-muted-foreground" data-slot="t1-read-notice">
          {details.suffixResolution}
        </p>
      )}
      {notes && (
        <p className="text-xs text-muted-foreground" data-slot="t1-read-notice">
          {notes}
        </p>
      )}
      {diagnostics && (
        <p className="text-warning text-xs" data-slot="t1-read-diagnostics">
          {diagnostics}
        </p>
      )}
      {details.truncation && <TruncationNotice meta={details.truncation} />}
    </section>
  );
}

function CodePreview({
  content,
  lineNumbers,
  startLine,
  target,
}: {
  readonly content: string;
  /**
   * The number of each line as omp sent them (not always consecutive; `null` marks a row that stands
   * for lines omp left out). Counted from `startLine` when absent.
   */
  readonly lineNumbers?: readonly (number | null)[];
  readonly startLine: number;
  readonly target: string;
}) {
  const lines = content.split("\n");
  // Rows only ever append or are replaced whole, so a row's position is a stable key.
  const numberedLines = lines.map((line, index) => ({
    id: `row-${index}`,
    line,
    lineNumber: lineNumbers === undefined ? startLine + index : (lineNumbers[index] ?? null),
  }));
  const language = languageForTarget(target);
  return (
    <div className="border-border bg-muted/30 overflow-hidden rounded-lg border" data-markdown-code>
      <div className="border-border/60 bg-muted/60 border-b px-3 py-1.5 text-xs">
        <span className="font-mono text-muted-foreground" data-code-language>
          {language}
        </span>
      </div>
      <pre
        className="max-w-full overflow-x-auto p-3 text-sm leading-relaxed"
        data-slot="t1-read-code"
      >
        <code className="font-mono text-info">
          {numberedLines.map(({ id, line, lineNumber: currentLine }) => (
            <span className="block" key={id}>
              <span
                aria-hidden="true"
                className="mr-4 inline-block min-w-8 select-none text-right text-muted-foreground"
              >
                {currentLine}
              </span>
              <span>{line || " "}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function TruncationNotice({ meta }: { readonly meta: TruncationMeta }) {
  const left = omittedOf(meta);
  const omitted = [
    left.lines === undefined || left.lines === 0 ? "" : `${left.lines} lines`,
    left.bytes === undefined || left.bytes === 0 ? "" : `${left.bytes} bytes`,
  ].filter(Boolean);
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      data-slot="t1-read-truncation"
    >
      <Icons.info aria-hidden="true" className="size-3.5" />
      <span>
        {omitted.length > 0
          ? `Output shortened; omitted ${omitted.join(" and ")}`
          : "Output shortened"}
      </span>
      {meta.artifactId && (
        <Button
          disabled
          size="xs"
          title="Full output retrieval is not available in this renderer."
          type="button"
          variant="outline"
        >
          Show full output
        </Button>
      )}
    </div>
  );
}

function imageSourceFor(details: ReadToolDetails): string | undefined {
  const mimeType = contentTypeFor(details);
  if (mimeType?.startsWith("image/") !== true) return undefined;
  const data = "data" in details && typeof details.data === "string" ? details.data : undefined;
  const image = "image" in details && typeof details.image === "string" ? details.image : undefined;
  const value = image ?? data;
  if (value === undefined) return undefined;
  if (value.startsWith("data:")) {
    return value.startsWith("data:image/") ? value : undefined;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) return undefined;
  return `data:${mimeType};base64,${value}`;
}

function contentTypeFor(details: ReadToolDetails): string | undefined {
  const contentType =
    details.contentType ??
    ("mimeType" in details && typeof details.mimeType === "string" ? details.mimeType : undefined);
  return contentType?.split(";", 1)[0]?.trim().toLowerCase();
}

function binaryContentFor(details: ReadToolDetails, mimeType: string | undefined): boolean {
  if ("isBinary" in details && details.isBinary === true) return true;
  if (mimeType === undefined || mimeType.startsWith("image/") || mimeType.startsWith("text/")) {
    return false;
  }
  return ![
    "application/ecmascript",
    "application/graphql",
    "application/javascript",
    "application/json",
    "application/typescript",
    "application/xml",
    "application/x-yaml",
    "application/yaml",
  ].includes(mimeType);
}

function diagnosticMessages(details: ReadToolDetails): string | undefined {
  const messages = details.meta?.diagnostics
    ?.flatMap((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
      if (!("message" in value) || typeof value.message !== "string") return [];
      return [middleEllipsis(value.message, 240)];
    })
    .slice(0, 4);
  return messages && messages.length > 0 ? messages.join(" · ") : undefined;
}

function languageForTarget(target: string): string {
  const extension = target.toLowerCase().split(".").pop() ?? "";
  const languages: Record<string, string> = {
    css: "css",
    html: "html",
    js: "javascript",
    json: "json",
    md: "markdown",
    ts: "typescript",
    tsx: "tsx",
  };
  return languages[extension] ?? "text";
}

function displayTarget(
  args: { readonly path?: string; readonly file_path?: string } | undefined,
  details: Pick<ReadToolDetails, "displayTarget" | "resolvedPath" | "url"> | undefined,
): string {
  return (
    details?.displayTarget ??
    details?.resolvedPath ??
    args?.path ??
    args?.file_path ??
    details?.url ??
    "read"
  );
}

function selectorText(
  args: { readonly offset?: number; readonly limit?: number } | undefined,
  details: ReadToolDetails,
): string | undefined {
  // omp lists the number of every line it shows (null for lines it left out): the range is exact.
  const listed = details.displayContent?.lineNumbers;
  if (Array.isArray(listed)) {
    const shown = listed.filter((number): number is number => number !== null);
    const first = shown[0];
    const last = shown[shown.length - 1];
    if (first !== undefined && last !== undefined) {
      return first === last ? `line ${first}` : `lines ${first}–${last}`;
    }
  }
  const start =
    details.displayContent?.startLine ?? (args?.offset === undefined ? undefined : args.offset + 1);
  if (start === undefined) return undefined;
  const end = args?.limit === undefined ? undefined : start + args.limit - 1;
  return end === undefined ? `line ${start}` : `lines ${start}–${end}`;
}

function middleEllipsis(value: string, max = 96): string {
  if (value.length <= max) return value;
  const side = Math.floor((max - 1) / 2);
  return `${value.slice(0, side)}…${value.slice(-side)}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return safeJson(value);
}
