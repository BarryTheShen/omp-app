import { AppError as AppErrorSchema, AppFailure } from "@omp-app/contracts";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { fileLanguageLabel } from "../U1/markdown/code-language";
import { CodeView } from "../U1/markdown/code-view";
import { ToolCard } from "../U3/tool-card/card";
import type {
  ToolCardError,
  ToolCardState,
  OutputMeta as ToolOutputMeta,
  ToolRenderer,
  ToolRendererProps,
} from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { omittedOf, type OutputMeta as ParsedOutputMeta } from "../U3/tool-card/output-meta";
import { detailsSource, splitToolResult } from "../U3/tool-card/result";
import type { ArtifactSlot, CopyKind } from "../U3/tool-card/slots";
import { TextOutput } from "../U3/tool-card/text-output";
import {
  type Diagnostic,
  decodeWriteArgs,
  decodeWriteDetails,
  type WriteToolDetails,
} from "./models";

const MAX_SOURCE_LINES = 16;
const MAX_SOURCE_CHARACTERS = 8_000;
const MAX_SVG_PREVIEW_CHARACTERS = 64_000;
const MAX_MERMAID_PREVIEW_CHARACTERS = 16_000;
const MAX_MERMAID_EDGES = 200;
const MAX_DIAGNOSTICS = 8;

export interface WriteCardProps {
  readonly rendererProps: ToolRendererProps;
  readonly artifactSlot?: ArtifactSlot;
  readonly onCopy?: (raw: string, kind: CopyKind) => void | Promise<void>;
  readonly onOpenArtifact?: () => void | Promise<void>;
}

/** Renders one normalized write call without executing it or reading the target path. */
export function WriteCard({ rendererProps, artifactSlot, onCopy, onOpenArtifact }: WriteCardProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const args = decodeWriteArgs(rendererProps.args);
  const looseArgs = looseWriteArgs(rendererProps.args);
  const rawDetails = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const details = decodeDetails(detailsSource(rawDetails));
  const detailsValue = details.ok ? details.value : undefined;
  const outputMeta = mergeOutputMeta(normalized.outputMeta, toToolOutputMeta(detailsValue?.meta));
  const source = args.ok ? args.value.content : looseArgs.content;
  const target = args.ok
    ? (args.value.path ?? args.value.file_path)
    : (looseArgs.path ?? looseArgs.file_path ?? detailsValue?.resolvedPath);
  const displayTarget = target ?? detailsValue?.resolvedPath ?? "write";
  const settledMalformed =
    rawDetails !== undefined &&
    !details.ok &&
    normalized.phase !== "running" &&
    normalized.phase !== "partial";
  const state = writeState(
    normalized,
    settledMalformed ? details.error : undefined,
    appErrorFromResult(rawDetails),
    outputMeta,
  );
  const rawResult = rawText(rawDetails);
  // A plain file write needs no answer (the card shows the source). A device's answer, a worker's
  // receipt or a process action is the whole point of the call, so the text omp returned is shown.
  const returnedText =
    detailsValue?.resolvedPath === undefined && state.phase === "success"
      ? splitToolResult(rawDetails).text
      : "";

  return (
    <div data-slot="t1-write-card" data-testid="t1-write-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden [&_[data-slot='u3-tool-card-truncation']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
        rawResult={rawResult}
        state={{ ...state, result: undefined, partialResult: undefined }}
        summary={middleEllipsis(displayTarget)}
      >
        <WriteBody
          artifactSlot={artifactSlot}
          details={detailsValue}
          displayTarget={displayTarget}
          onCopy={onCopy}
          onOpenArtifact={onOpenArtifact}
          outputMeta={outputMeta}
          returnedText={returnedText}
          source={source}
          waiting={
            (state.phase === "running" || state.phase === "partial") && state.queued !== true
          }
        />
      </ToolCard>
    </div>
  );
}

/** Assistant-ui backend renderer entry used by T1's descriptor composition. */
export const WriteToolRenderer: ToolRenderer = (props) => <WriteCard rendererProps={props} />;

function WriteBody({
  artifactSlot,
  details,
  displayTarget,
  onCopy,
  onOpenArtifact,
  outputMeta,
  returnedText,
  source,
  waiting,
}: {
  readonly artifactSlot?: ArtifactSlot;
  readonly details?: WriteToolDetails;
  readonly displayTarget: string;
  readonly onCopy?: (raw: string, kind: CopyKind) => void | Promise<void>;
  readonly onOpenArtifact?: () => void | Promise<void>;
  readonly outputMeta?: ToolOutputMeta;
  readonly returnedText: string;
  readonly source?: string;
  /** The call is still being written, so a missing source is not there yet. */
  readonly waiting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const content = source ?? "";
  const hasSource = source !== undefined;
  const language = fileLanguageLabel(displayTarget, content);
  const lineCount = lineCountFor(content);
  const preview = useMemo(() => sourcePreview(content, expanded), [content, expanded]);
  const isMermaid = isMermaidTarget(displayTarget);
  const svg = isSvg(displayTarget, content);
  const artifactId = outputMeta?.artifactId ?? outputMeta?.truncation?.artifactId;
  const artifactElidedBytes =
    outputMeta?.artifactElidedBytes ?? outputMeta?.truncation?.artifactElidedBytes;
  const diagnostics = diagnosticsFor(details);
  const metadataNotices = metadataNotice(outputMeta);
  const copySource = async (): Promise<void> => {
    if (onCopy !== undefined) {
      await onCopy(content, "code");
      return;
    }
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      throw new Error("Clipboard unavailable");
    }
    await navigator.clipboard.writeText(content);
  };

  return (
    <section
      className="ms-2 flex min-w-0 flex-col gap-2 border-s-2 border-border/70 py-2 ps-4"
      data-slot="t1-write-body"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          className="min-w-0 max-w-full truncate font-mono"
          data-slot="t1-write-target"
          title={displayTarget}
        >
          {middleEllipsis(displayTarget)}
        </span>
        {hasSource && (
          <>
            <span
              className="rounded border border-border px-2 py-0.5"
              data-slot="t1-write-language"
            >
              {language}
            </span>
            <span
              className="rounded border border-border px-2 py-0.5"
              data-slot="t1-write-line-count"
            >
              {lineCount} {lineCount === 1 ? "line" : "lines"}
            </span>
          </>
        )}
        {details?.madeExecutable === true && (
          <span className="rounded border border-success/40 bg-success-surface px-2 py-0.5 text-success-surface-foreground">
            Executable
          </span>
        )}
        {hasShebang(content) && (
          <span className="rounded border border-info/40 bg-info-surface px-2 py-0.5 text-info-surface-foreground">
            Shebang
          </span>
        )}
        {details?.xdev !== undefined && (
          <span className="rounded border border-border px-2 py-0.5" data-slot="t1-write-device">
            {deviceName(details.xdev)}
          </span>
        )}
        {details?.proc !== undefined && (
          <span className="rounded border border-border px-2 py-0.5" data-slot="t1-write-delegated">
            Background job
          </span>
        )}
        {details?.cfg !== undefined && (
          <span className="rounded border border-border px-2 py-0.5" data-slot="t1-write-delegated">
            Setting change
          </span>
        )}
      </div>
      {hasSource ? (
        <SourcePreview
          content={content}
          expanded={expanded}
          language={language}
          mermaid={isMermaid}
          onCopy={copySource}
          onExpand={() => setExpanded(true)}
          preview={preview}
          svg={svg}
          target={displayTarget}
        />
      ) : (
        waiting && (
          <div
            className="border-border bg-muted/40 rounded-lg border p-3 text-sm text-muted-foreground"
            data-slot="t1-write-empty"
          >
            Waiting for source content…
          </div>
        )
      )}
      {returnedText !== "" && <TextOutput text={returnedText} testId="t1-write-returned" />}
      {diagnostics.length > 0 && <Diagnostics diagnostics={diagnostics} />}
      {metadataNotices.length > 0 && <MetadataNotices notices={metadataNotices} />}
      {artifactId !== undefined && (
        <ArtifactNotice
          artifactId={artifactId}
          artifactElidedBytes={artifactElidedBytes}
          artifactSlot={artifactSlot}
          onOpenArtifact={onOpenArtifact}
          outputMeta={outputMeta}
        />
      )}
    </section>
  );
}

type MermaidPreviewState =
  | { readonly kind: "empty" }
  | { readonly kind: "loading" }
  | { readonly kind: "rendered"; readonly dataUrl: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" };

/**
 * Render only Mermaid source from Mermaid file targets. Strict Mermaid security settings plus an
 * image data URL keep generated markup out of the live document; raw source always remains below.
 */
function MermaidPreview({
  content,
  target,
}: {
  readonly content: string;
  readonly target: string;
}) {
  const diagramId = `t1-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  const [state, setState] = useState<MermaidPreviewState>({ kind: "empty" });

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let current = true;
    if (content.trim() === "") {
      setState({ kind: "empty" });
      return () => {
        current = false;
      };
    }
    if (content.length > MAX_MERMAID_PREVIEW_CHARACTERS) {
      setState({ kind: "too-large" });
      return () => {
        current = false;
      };
    }

    setState({ kind: "loading" });
    const timeout = setTimeout(() => {
      void (async () => {
        try {
          const { default: mermaid } = await import("mermaid");
          mermaid.initialize({
            darkMode: dark,
            fontFamily: "Public Sans, sans-serif",
            htmlLabels: false,
            maxEdges: MAX_MERMAID_EDGES,
            maxTextSize: MAX_MERMAID_PREVIEW_CHARACTERS,
            secure: [
              "secure",
              "securityLevel",
              "startOnLoad",
              "maxTextSize",
              "maxEdges",
              "suppressErrorRendering",
              "htmlLabels",
            ],
            securityLevel: "strict",
            startOnLoad: false,
            suppressErrorRendering: true,
            theme: dark ? "dark" : "default",
          });
          const rendered = await mermaid.render(diagramId, content);
          if (current) setState({ kind: "rendered", dataUrl: svgDataUrl(rendered.svg) });
        } catch {
          if (current) setState({ kind: "invalid" });
        }
      })();
    }, 80);
    return () => {
      current = false;
      clearTimeout(timeout);
    };
  }, [content, dark, diagramId]);

  if (state.kind === "empty") return null;
  if (state.kind === "loading") {
    return (
      <p
        className="border-border bg-muted/40 rounded-lg border px-3 py-2 text-xs text-muted-foreground"
        data-slot="t1-write-mermaid-loading"
        role="status"
      >
        Rendering Mermaid diagram…
      </p>
    );
  }
  if (state.kind === "too-large") {
    return (
      <p
        className="border-border bg-muted/40 rounded-lg border px-3 py-2 text-xs text-muted-foreground"
        data-slot="t1-write-mermaid-oversized"
        role="status"
      >
        Mermaid preview omitted for large source; use the raw source or artifact.
      </p>
    );
  }
  if (state.kind === "invalid") {
    return (
      <p
        className="border-border bg-muted/40 rounded-lg border px-3 py-2 text-xs text-muted-foreground"
        data-slot="t1-write-mermaid-error"
        role="status"
      >
        Mermaid preview unavailable; the raw source is shown.
      </p>
    );
  }
  return (
    <div
      className="border-border/60 bg-muted relative inline-flex max-h-96 max-w-full items-center overflow-auto rounded border p-3"
      data-slot="t1-write-mermaid-preview"
      data-testid="t1-write-mermaid-preview"
      role="img"
      aria-label={`${target} Mermaid diagram preview`}
    >
      <img
        alt=""
        className="max-h-80 max-w-full object-contain"
        decoding="async"
        referrerPolicy="no-referrer"
        src={state.dataUrl}
      />
    </div>
  );
}

function SourcePreview({
  content,
  expanded,
  language,
  mermaid: isMermaid,
  onCopy,
  onExpand,
  preview,
  svg,
  target,
}: {
  readonly content: string;
  readonly expanded: boolean;
  readonly language: string;
  readonly mermaid: boolean;
  readonly onCopy: () => Promise<void>;
  readonly onExpand: () => void;
  readonly preview: SourcePreviewValue;
  readonly svg: boolean;
  readonly target: string;
}) {
  const imagePreview = svg && content.length <= MAX_SVG_PREVIEW_CHARACTERS;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-slot="t1-write-source">
      {isMermaid && <MermaidPreview content={content} target={target} />}
      {imagePreview && (
        <div
          className="border-border/60 bg-muted relative inline-flex max-w-full items-center overflow-hidden rounded border p-3"
          data-slot="t1-write-svg-preview"
          style={{
            backgroundImage:
              "linear-gradient(45deg, var(--muted-foreground) 25%, transparent 25%, transparent 75%, var(--muted-foreground) 75%), linear-gradient(45deg, var(--muted-foreground) 25%, transparent 25%, transparent 75%, var(--muted-foreground) 75%)",
            backgroundPosition: "0 0, var(--space-sm) var(--space-sm)",
            backgroundSize: "calc(var(--space-sm) * 2) calc(var(--space-sm) * 2)",
          }}
        >
          <img
            alt={`${target} SVG preview`}
            className="max-h-40 max-w-full object-contain"
            decoding="async"
            referrerPolicy="no-referrer"
            src={svgDataUrl(content)}
          />
        </div>
      )}
      {svg && !imagePreview && (
        <p
          className="border-border bg-muted/40 rounded-lg border px-3 py-2 text-xs text-muted-foreground"
          data-slot="t1-write-svg-unavailable"
        >
          SVG preview omitted for large source; use the raw source or artifact.
        </p>
      )}
      <CodeView
        code={preview.lines.map((row) => row.line).join("\n")}
        copyLabel="Copy raw source"
        language={language}
        lineNumbers={preview.lines.map((row) => row.number)}
        onCopy={onCopy}
      />
      {preview.truncated && !expanded && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground"
          data-slot="t1-write-source-truncation"
        >
          <span>{preview.label}</span>
          <Button size="xs" type="button" variant="outline" onClick={onExpand}>
            Show full source
          </Button>
        </div>
      )}
    </div>
  );
}

function Diagnostics({ diagnostics }: { readonly diagnostics: readonly Diagnostic[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs" data-slot="t1-write-diagnostics">
      {diagnostics.map((diagnostic) => {
        const severity = diagnostic.severity ?? "info";
        return (
          <p
            className={
              severity === "error"
                ? "text-danger"
                : severity === "warning"
                  ? "text-warning"
                  : "text-muted-foreground"
            }
            key={`${severity}-${diagnostic.path ?? "diagnostic"}-${diagnostic.line ?? 0}-${diagnostic.column ?? 0}-${diagnostic.message ?? "notice"}`}
          >
            <span className="font-medium">{severity}:</span> {diagnosticText(diagnostic)}
          </p>
        );
      })}
    </div>
  );
}

function MetadataNotices({ notices }: { readonly notices: readonly string[] }) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1 text-xs text-warning"
      data-slot="t1-write-metadata-notices"
    >
      {notices.map((notice) => (
        <p key={notice}>{notice}</p>
      ))}
    </div>
  );
}

function ArtifactNotice({
  artifactId,
  artifactElidedBytes,
  artifactSlot,
  onOpenArtifact,
  outputMeta,
}: {
  readonly artifactId: string;
  readonly artifactElidedBytes?: number;
  readonly artifactSlot?: ArtifactSlot;
  readonly onOpenArtifact?: () => void | Promise<void>;
  readonly outputMeta?: ToolOutputMeta;
}) {
  const [openError, setOpenError] = useState<string>();
  const error = outputMeta?.artifactError;
  const errorText = error === undefined ? openError : safeMetadataText(error);
  const open =
    onOpenArtifact === undefined
      ? undefined
      : async () => {
          try {
            await onOpenArtifact();
            setOpenError(undefined);
          } catch {
            setOpenError("Artifact could not be opened.");
          }
        };
  const openSlot = async () => {
    if (open === undefined) {
      setOpenError("Artifact action unavailable.");
      return;
    }
    await open();
  };
  if (artifactSlot !== undefined) {
    return artifactSlot({
      artifactId,
      label: "Full artifact",
      elidedBytes: artifactElidedBytes,
      error: errorText,
      onOpen: openSlot,
    });
  }
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      data-slot="t1-write-artifact"
    >
      <span>
        Artifact available: <span className="font-mono">{artifactId}</span>
        {artifactElidedBytes !== undefined && ` (${artifactElidedBytes} bytes omitted)`}
      </span>
      <Button
        aria-label={open === undefined ? "Artifact action unavailable" : "Open full artifact"}
        disabled={open === undefined}
        size="xs"
        type="button"
        variant="outline"
        onClick={open}
      >
        {open === undefined ? "Artifact action unavailable" : "Open full artifact"}
      </Button>
      {errorText && <span className="text-danger">{errorText}</span>}
    </div>
  );
}

type SourcePreviewLine = { readonly line: string; readonly number: number };
type SourcePreviewValue = {
  readonly lines: readonly SourcePreviewLine[];
  readonly truncated: boolean;
  readonly label: string;
};

type LooseWriteArgs = {
  readonly path?: string;
  readonly file_path?: string;
  readonly content?: string;
};

type DecodedDetails =
  | { readonly ok: true; readonly value?: WriteToolDetails }
  | { readonly ok: false; readonly error: Error };

function decodeDetails(value: unknown): DecodedDetails {
  if (value === undefined || value === null || typeof value === "string") {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      error: new AppFailure({
        code: "invalid_args",
        message: "Malformed write details; showing the raw write result.",
        retryable: false,
      }),
    };
  }
  const decoded = decodeWriteDetails(value);
  return decoded.ok ? decoded : { ok: false, error: decoded.error };
}

function writeState(
  normalized: ToolCardState,
  malformedDetails: Error | undefined,
  resultError: ToolCardError | undefined,
  outputMeta: ToolOutputMeta | undefined,
): ToolCardState {
  if (malformedDetails === undefined && resultError === undefined) {
    return { ...normalized, outputMeta };
  }
  const error =
    resultError ??
    ({
      code: "invalid_args",
      message: malformedDetails?.message ?? "The write result could not be decoded.",
      retryable: false,
    } satisfies ToolCardError);
  return {
    ...normalized,
    phase: "error",
    isError: true,
    error,
    outputMeta,
  };
}

function appErrorFromResult(value: unknown): ToolCardError | undefined {
  const candidates = [
    value,
    value instanceof AppFailure ? value.appError : undefined,
    isRecord(value) ? value.error : undefined,
  ];
  for (const candidate of candidates) {
    const parsed = AppErrorSchema.safeParse(candidate);
    if (parsed.success) {
      return {
        code: parsed.data.code,
        message: parsed.data.message,
        retryable: parsed.data.retryable,
        timeout: parsed.data.code === "timeout",
      };
    }
  }
  return undefined;
}

function looseWriteArgs(value: unknown): LooseWriteArgs {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.file_path === "string" ? { file_path: value.file_path } : {}),
    ...(typeof value.content === "string" ? { content: value.content } : {}),
  };
}

function toToolOutputMeta(value: ParsedOutputMeta | undefined): ToolOutputMeta | undefined {
  if (value === undefined) return undefined;
  const truncation = value.truncation;
  const omitted = truncation === undefined ? undefined : omittedOf(truncation);
  return {
    source: value.source?.value,
    artifactId: value.artifactId,
    artifactElidedBytes: value.artifactElidedBytes,
    artifactError: value.artifactError,
    diagnostics: value.diagnostics,
    limits:
      value.limits === undefined
        ? undefined
        : Object.entries(value.limits).map(([name, detail]) => ({ name, detail })),
    ...(truncation === undefined
      ? {}
      : {
          truncation: {
            direction: truncation.direction ?? "head",
            reason: truncation.truncatedBy ?? "lines",
            totalLines: truncation.totalLines,
            shownLines: truncation.outputLines,
            totalBytes: truncation.totalBytes,
            shownBytes: truncation.outputBytes,
            shownHead: truncation.headRange ?? truncation.shownRange,
            shownTail: truncation.tailRange,
            omittedLines: omitted?.lines,
            omittedBytes: omitted?.bytes,
            artifactId: truncation.artifactId,
            offset: truncation.nextOffset,
            partialLine: truncation.lastLinePartial,
          },
        }),
  };
}
function mergeOutputMeta(
  base: ToolOutputMeta | undefined,
  details: ToolOutputMeta | undefined,
): ToolOutputMeta | undefined {
  if (base === undefined) return details;
  if (details === undefined) return base;
  return {
    ...base,
    ...details,
    truncation: details.truncation ?? base.truncation,
    diagnostics: details.diagnostics ?? base.diagnostics,
    limits: details.limits ?? base.limits,
  };
}

function sourcePreview(content: string, expanded: boolean): SourcePreviewValue {
  let lines = content.split(/\r?\n/);
  if (content.length === 0) lines = [""];
  if (expanded) {
    return {
      lines: lines.map((line, index) => ({ line, number: index + 1 })),
      truncated: false,
      label: `${lines.length} lines`,
    };
  }
  const byLine = lines.length > MAX_SOURCE_LINES;
  const byCharacters = content.length > MAX_SOURCE_CHARACTERS;
  if (!byLine && !byCharacters) {
    return {
      lines: lines.map((line, index) => ({ line, number: index + 1 })),
      truncated: false,
      label: `${lines.length} lines`,
    };
  }
  const maxCharacters = Math.min(MAX_SOURCE_CHARACTERS, content.length);
  const visible: SourcePreviewLine[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    if (visible.length >= MAX_SOURCE_LINES || used + line.length > maxCharacters) break;
    visible.push({ line, number: index + 1 });
    used += line.length + 1;
  }
  const firstLine = lines[0];
  if (visible.length === 0 && firstLine !== undefined) {
    visible.push({ line: firstLine.slice(0, maxCharacters), number: 1 });
  }
  return {
    lines: visible,
    truncated: true,
    label: `Source preview shortened; ${Math.max(0, lines.length - visible.length)} lines omitted`,
  };
}

function diagnosticsFor(details: WriteToolDetails | undefined): readonly Diagnostic[] {
  const diagnostics = details?.diagnostics ?? [];
  return diagnostics.slice(0, MAX_DIAGNOSTICS);
}

function metadataNotice(outputMeta: ToolOutputMeta | undefined): readonly string[] {
  if (outputMeta === undefined) return [];
  const notices: string[] = [];
  const truncation = outputMeta.truncation;
  if (
    truncation !== undefined &&
    outputMeta.artifactId === undefined &&
    truncation.artifactId === undefined
  ) {
    const omitted = truncation.omittedLines ?? truncation.omittedBytes;
    notices.push(
      omitted === undefined
        ? "Source metadata indicates a shortened result."
        : `Source metadata omitted ${omitted} ${truncation.omittedLines !== undefined ? "lines" : "bytes"}.`,
    );
  }
  if (outputMeta.limits !== undefined && outputMeta.limits.length > 0) {
    notices.push(
      `${outputMeta.limits.length} output limit notice${outputMeta.limits.length === 1 ? "" : "s"}.`,
    );
  }
  if (outputMeta.diagnostics !== undefined && outputMeta.diagnostics.length > 0) {
    notices.push(
      `${outputMeta.diagnostics.length} metadata diagnostic${outputMeta.diagnostics.length === 1 ? "" : "s"}.`,
    );
  }
  return notices;
}

function diagnosticText(diagnostic: Diagnostic): string {
  const location = [diagnostic.path, diagnostic.line, diagnostic.column]
    .filter((value) => value !== undefined)
    .join(":");
  const message = diagnostic.message ?? "Diagnostic reported without a message.";
  return location.length > 0 ? `${location}: ${message}` : message;
}

function lineCountFor(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
}

function hasShebang(content: string): boolean {
  return content.startsWith("#!");
}

/** The tool a call to a device (`xd://...`) ran, from omp's record of it (`{ tool, mode, args, tier }`). */
function deviceName(xdev: unknown): string {
  if (
    typeof xdev === "object" &&
    xdev !== null &&
    "tool" in xdev &&
    typeof xdev.tool === "string"
  ) {
    return xdev.tool;
  }
  return "Device call";
}

function isMermaidTarget(target: string): boolean {
  const path = target.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  return path.endsWith(".mmd") || path.endsWith(".mermaid");
}
function isSvg(target: string, content: string): boolean {
  return (
    target.toLowerCase().split(/[?#]/, 1)[0]?.endsWith(".svg") === true ||
    /^\s*<svg(?:\s|>)/i.test(content)
  );
}

function svgDataUrl(content: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
}

function rawText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[Unserializable result]";
  }
}

function safeMetadataText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "Artifact unavailable.";
  return typeof value.message === "string" ? value.message : "Artifact unavailable.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function middleEllipsis(value: string, max = 96): string {
  if (value.length <= max) return value;
  const edge = Math.floor((max - 1) / 2);
  return `${value.slice(0, edge)}…${value.slice(-edge)}`;
}
