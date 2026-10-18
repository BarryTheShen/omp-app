import { useState } from "react";
import { z } from "zod";
import { Button } from "../../components/ui/button";
import { MarkdownContent } from "../U1/markdown";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolCardState, ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { decodeLspDetails, type LspToolArgs, LspToolArgsSchema } from "./models";

const MAX_ROWS = 20;
const MAX_TEXT_LINES = 40;

const CHIP = "shrink-0 rounded-full border px-2 py-0.5 text-[0.7rem] font-medium leading-tight";
const TONES = {
  danger: "border-danger/30 bg-danger-surface text-danger-surface-foreground",
  warning: "border-warning/30 bg-warning-surface text-warning-surface-foreground",
  muted: "border-border bg-muted text-muted-foreground",
} as const;

/** Arguments may still be streaming, so every field is optional here. */
const PartialLspArgsSchema = LspToolArgsSchema.partial();

/** omp's lsp answer is the result's text content; details carry only the request and outcome. */
const LspResultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  details: z.unknown().optional(),
});

/** omp v18.6.1 text formats (packages/coding-agent/src/lsp/utils.ts:187-305,412-436). */
const GROUPED_HEADER_RE = /^(#+)\s+(.*)$/;
const DIAGNOSTIC_RE =
  /^(.+?):(\d+):(\d+)\s+\[(\w+)\]\s+(?:\[([^\]]+)\]\s+)?(.+?)(?:\s+\(([^)]+)\))?$/;
const GROUPED_DIAGNOSTIC_RE = /^\d+:\d+\s+\[/;
const DIAGNOSTICS_SUMMARY_RE = /^\d+ \w+\(s\)(?:, \d+ \w+\(s\))*:?$/;
const FILE_SUMMARY_RE = /: (?:no issues|\d+ \w+\(s\)(?:, \d+ \w+\(s\))*)$/;
const STATUS_GLYPH_RE = /^(?:\[[^\]\s]*\]|[^\p{L}\p{N}\s./~\\]+)\s+/u;
const LOCATION_RE = /^ {2}(\S.*?):(\d+):(\d+)$/;
const FOUND_COUNT_RE = /^Found (\d+) /;
const DOCUMENT_SYMBOLS_RE = /^Symbols in (.+):$/;
const DOCUMENT_SYMBOL_RE = /^\s*\S+\s+(.+?)\s*@\s*line\s*(\d+)$/;
const WORKSPACE_SYMBOL_RE = /^\s+\S+\s+(.+?)\s+@\s+(.+):(\d+):(\d+)$/;
const APPLIED_EDIT_RE = /^Applied (\d+) edit\(s\) to (.+)$/;
const PREVIEW_EDIT_RE = /^(.+): (\d+) edits?$/;

type Severity = "error" | "warning" | "info" | "hint";

interface DiagnosticRow {
  readonly key: string;
  readonly severity: Severity | "failed" | "partial";
  readonly location: string | undefined;
  readonly message: string;
}

interface LocationRow {
  readonly key: string;
  readonly location: string;
  readonly name: string | undefined;
}

interface RenameRow {
  readonly key: string;
  readonly file: string | undefined;
  readonly edits: number | undefined;
  readonly text: string;
}

export function LspCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const result = normalized.result ?? normalized.partialResult;
  const parsedResult = result === undefined ? undefined : LspResultSchema.safeParse(result);
  const envelope = parsedResult?.success ? parsedResult.data : undefined;
  const details = envelope === undefined ? undefined : decodeLspDetails(envelope.details ?? {});
  const parsedDetails = details?.ok ? details.value : undefined;
  const args = PartialLspArgsSchema.safeParse(rendererProps.args);
  const requestArgs = PartialLspArgsSchema.safeParse(parsedDetails?.request);
  const request = args.success ? args.data : requestArgs.success ? requestArgs.data : undefined;
  const action = request?.action ?? parsedDetails?.action;
  const text = envelope?.content
    .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    .join("\n");
  const rawResult = rawText(result);
  const settled = normalized.phase === "success";
  const failed = settled && parsedDetails?.success === false;
  const textLines = (text ?? "").split("\n").filter((line) => line.trim().length > 0);
  const state: ToolCardState = failed
    ? {
        ...normalized,
        phase: "error",
        isError: true,
        error: {
          message: textLines[0]?.trim() ?? "The language server request failed.",
          retryable: false,
        },
      }
    : normalized;
  const summary = lspSummary({ ...request, action });
  const failureDetail = failed ? textLines.slice(1).join("\n") : "";
  const showBody = settled && !failed && text !== undefined && text.trim().length > 0;
  const showUnavailable = settled && envelope === undefined;

  return (
    <div data-testid={`t2-lsp-card-${normalized.toolCallId}`}>
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawResult}
        state={state}
        summary={summary}
      >
        {(showBody || showUnavailable || failureDetail.length > 0) && (
          <div className="py-2 text-sm">
            {showBody && <LspBody action={action} text={text ?? ""} />}
            {failureDetail.length > 0 && <TextOutput text={failureDetail} />}
            {showUnavailable && (
              <p className="text-muted-foreground text-xs">Language server details unavailable.</p>
            )}
          </div>
        )}
      </ToolCard>
    </div>
  );
}

export const LspToolRenderer: ToolRenderer = (props) => <LspCard rendererProps={props} />;

function LspBody({ action, text }: { readonly action: string | undefined; readonly text: string }) {
  if (action === "hover") return <MarkdownContent text={text} variant="compact" />;
  if (action === "diagnostics") return <Diagnostics text={text} />;
  if (
    action === "references" ||
    action === "definition" ||
    action === "type_definition" ||
    action === "implementation"
  ) {
    return <Locations rows={locationRows(text)} text={text} />;
  }
  if (action === "symbols") return <Locations rows={symbolRows(text)} text={text} />;
  if (action === "rename") return <RenameEdits text={text} />;
  return <TextOutput text={text} />;
}

function Diagnostics({ text }: { readonly text: string }) {
  const { rows, other } = diagnosticRows(text);
  const shown = rows.slice(0, MAX_ROWS);
  if (rows.length === 0 && other.length === 0) {
    return <p className="text-muted-foreground text-xs">No issues.</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {shown.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="t2-lsp-diagnostics">
          {shown.map((row) => (
            <li className="flex min-w-0 flex-wrap items-baseline gap-2 text-xs" key={row.key}>
              <span className={`${CHIP} ${TONES[severityTone(row.severity)]}`}>
                {SEVERITY_LABELS[row.severity]}
              </span>
              {row.location !== undefined && (
                <span className="text-muted-foreground font-mono">{row.location}</span>
              )}
              <span className="text-foreground min-w-0">{row.message}</span>
            </li>
          ))}
          {rows.length > shown.length && (
            <li className="text-muted-foreground text-xs">
              Showing {shown.length} of {rows.length}
            </li>
          )}
        </ul>
      )}
      {other.length > 0 && <TextOutput text={other.join("\n")} />}
    </div>
  );
}

const SEVERITY_LABELS: Record<DiagnosticRow["severity"], string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
  hint: "Hint",
  failed: "Server failed",
  partial: "Partly failed",
};

function severityTone(severity: DiagnosticRow["severity"]): keyof typeof TONES {
  if (severity === "error" || severity === "failed") return "danger";
  if (severity === "warning" || severity === "partial") return "warning";
  return "muted";
}

function Locations({ rows, text }: { readonly rows: Rows<LocationRow>; readonly text: string }) {
  if (rows.items.length === 0) return <EmptyOrText text={text} />;
  const shown = rows.items.slice(0, MAX_ROWS);
  return (
    <ul className="flex flex-col gap-1" data-testid="t2-lsp-locations">
      {shown.map((row) => (
        <li className="flex min-w-0 items-baseline gap-2 text-xs" key={row.key}>
          <span className="text-foreground min-w-0 truncate font-mono" title={row.location}>
            {row.location}
          </span>
          {row.name !== undefined && (
            <span className="text-muted-foreground min-w-0 truncate">{row.name}</span>
          )}
        </li>
      ))}
      {rows.total > shown.length && (
        <li className="text-muted-foreground text-xs">
          Showing {shown.length} of {rows.total}
        </li>
      )}
    </ul>
  );
}

function RenameEdits({ text }: { readonly text: string }) {
  const lines = text.split("\n");
  const heading = lines[0]?.trim();
  if (heading !== "Applied rename:" && heading !== "Rename preview:") {
    return <EmptyOrText text={text} />;
  }
  const rows = renameRows(lines.slice(1));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-muted-foreground text-xs" data-testid="t2-lsp-rename-status">
        {heading === "Applied rename:"
          ? "Applied to the files below."
          : "Preview only, not applied."}
      </p>
      <ul className="flex flex-col gap-1" data-testid="t2-lsp-rename">
        {rows.map((row) => (
          <li className="flex min-w-0 items-baseline gap-2 text-xs" key={row.key}>
            {row.file === undefined ? (
              <span className="text-foreground min-w-0">{row.text}</span>
            ) : (
              <>
                <span className="text-foreground min-w-0 truncate font-mono" title={row.file}>
                  {row.file}
                </span>
                {row.edits !== undefined && (
                  <span className="text-muted-foreground shrink-0">
                    {row.edits.toLocaleString("en-US")} {row.edits === 1 ? "edit" : "edits"}
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyOrText({ text }: { readonly text: string }) {
  const trimmed = text.trim();
  if (!trimmed.includes("\n")) return <p className="text-muted-foreground text-xs">{trimmed}</p>;
  return <TextOutput text={trimmed} />;
}

function TextOutput({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const cut = !expanded && lines.length > MAX_TEXT_LINES;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <pre
        className="border-border bg-muted/40 text-foreground min-w-0 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
        data-testid="t2-lsp-text"
      >
        {cut ? lines.slice(0, MAX_TEXT_LINES).join("\n") : text}
      </pre>
      {cut && (
        <Button
          className="w-fit self-start"
          size="xs"
          type="button"
          variant="outline"
          onClick={() => setExpanded(true)}
        >
          Show all {lines.length.toLocaleString("en-US")} lines
        </Button>
      )}
    </div>
  );
}

interface Rows<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** Mirrors omp's own parser (packages/tui/src/tools/lsp.ts:761-799). */
function diagnosticRows(text: string): { rows: DiagnosticRow[]; other: string[] } {
  const rows: DiagnosticRow[] = [];
  const other: string[] = [];
  const dirAtDepth: string[] = [];
  let file: string | undefined;
  for (const rawLine of text.split("\n")) {
    const header = GROUPED_HEADER_RE.exec(rawLine);
    if (header !== null) {
      const depth = header[1]?.length ?? 1;
      const rest = (header[2] ?? "").trimEnd();
      dirAtDepth.length = depth - 1;
      if (rest.endsWith("/")) {
        dirAtDepth[depth - 1] = rest.slice(0, -1);
        file = undefined;
      } else {
        const prefix = dirAtDepth.filter(Boolean).join("/");
        file = prefix.length > 0 ? `${prefix}/${rest}` : rest;
      }
      continue;
    }
    const line = rawLine.trim();
    if (line.length === 0 || line === "OK" || DIAGNOSTICS_SUMMARY_RE.test(line)) continue;
    const key = `d${rows.length}`;
    if (/\ball language servers failed\b/.test(line)) {
      rows.push({
        key,
        severity: "failed",
        location: undefined,
        message: line.replace(STATUS_GLYPH_RE, ""),
      });
      continue;
    }
    if (/\bsome servers failed\b/.test(line)) {
      rows.push({
        key,
        severity: "partial",
        location: undefined,
        message: line.replace(STATUS_GLYPH_RE, ""),
      });
      continue;
    }
    if (FILE_SUMMARY_RE.test(line)) continue;
    const match = DIAGNOSTIC_RE.exec(
      file !== undefined && GROUPED_DIAGNOSTIC_RE.test(line) ? `${file}:${line}` : line,
    );
    const severity = match?.[4]?.toLowerCase();
    if (
      match === null ||
      (severity !== "error" && severity !== "warning" && severity !== "info" && severity !== "hint")
    ) {
      other.push(line);
      continue;
    }
    rows.push({
      key,
      severity,
      location: `${match[1]}:${match[2]}`,
      message: match[7] === undefined ? (match[6] ?? "") : `${match[6] ?? ""} (${match[7]})`,
    });
  }
  return { rows, other };
}

function locationRows(text: string): Rows<LocationRow> {
  const items: LocationRow[] = [];
  for (const line of text.split("\n")) {
    const match = LOCATION_RE.exec(line);
    if (match === null) continue;
    items.push({ key: `l${items.length}`, location: `${match[1]}:${match[2]}`, name: undefined });
  }
  return { items, total: foundCount(text) ?? items.length };
}

function symbolRows(text: string): Rows<LocationRow> {
  const lines = text.split("\n");
  const documentPath = DOCUMENT_SYMBOLS_RE.exec(lines[0] ?? "")?.[1];
  const items: LocationRow[] = [];
  for (const line of lines.slice(1)) {
    const key = `s${items.length}`;
    if (documentPath !== undefined) {
      const match = DOCUMENT_SYMBOL_RE.exec(line);
      if (match !== null)
        items.push({ key, location: `${documentPath}:${match[2]}`, name: match[1] });
      continue;
    }
    const match = WORKSPACE_SYMBOL_RE.exec(line);
    if (match !== null) items.push({ key, location: `${match[2]}:${match[3]}`, name: match[1] });
  }
  return { items, total: foundCount(text) ?? items.length };
}

function foundCount(text: string): number | undefined {
  const match = FOUND_COUNT_RE.exec(text);
  return match === null ? undefined : Number(match[1]);
}

function renameRows(lines: readonly string[]): RenameRow[] {
  const rows: RenameRow[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const key = `r${rows.length}`;
    const applied = APPLIED_EDIT_RE.exec(line);
    if (applied !== null) {
      rows.push({ key, file: applied[2], edits: Number(applied[1]), text: line });
      continue;
    }
    const preview = PREVIEW_EDIT_RE.exec(line);
    if (preview !== null) {
      rows.push({ key, file: preview[1], edits: Number(preview[2]), text: line });
      continue;
    }
    rows.push({ key, file: undefined, edits: undefined, text: line });
  }
  return rows;
}

const ACTION_TITLES: Record<string, string> = {
  diagnostics: "Diagnostics",
  definition: "Definition",
  references: "References",
  hover: "Hover",
  symbols: "Symbols",
  rename: "Rename",
  rename_file: "Rename file",
  code_actions: "Code actions",
  type_definition: "Type definition",
  implementation: "Implementation",
  status: "Status",
  reload: "Reload",
  capabilities: "Capabilities",
  request: "Request",
};

function lspSummary(request: Partial<LspToolArgs>): string | undefined {
  const action = request.action;
  if (action === undefined) return undefined;
  const title = ACTION_TITLES[action] ?? action.replace(/_/g, " ");
  const file = request.file === "*" ? "workspace" : request.file;
  const location =
    file !== undefined && request.line !== undefined ? `${file}:${request.line}` : file;
  const symbol = request.symbol?.replace(/\s+/g, " ").trim() || undefined;
  if (
    symbol !== undefined &&
    (action === "references" ||
      action === "definition" ||
      action === "type_definition" ||
      action === "implementation")
  ) {
    return `${title} ${action === "references" ? "to" : "of"} ${symbol}`;
  }
  if ((action === "rename" || action === "rename_file") && request.new_name !== undefined) {
    const from = action === "rename" ? (symbol ?? location) : file;
    return from === undefined
      ? `${title} → ${request.new_name}`
      : `${title} ${from} → ${request.new_name}`;
  }
  const target = location ?? request.query;
  return target === undefined ? title : `${title} · ${target}`;
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "The language server result could not be shown as text.";
  }
}
