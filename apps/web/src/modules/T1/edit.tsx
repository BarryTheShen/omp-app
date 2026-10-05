import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Icons } from "../../tokens";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolCardPhase, ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import {
  type Diagnostic,
  decodeEditArgs,
  decodeEditDetails,
  type EditPerFileResult,
  type EditToolArgs,
  type EditToolDetails,
} from "./models";

const MAX_DIFF_LINES = 96;
const MAX_DIFF_CHARS = 12_000;
const MAX_EXPANDED_DIFF_LINES = 480;
const MAX_EXPANDED_DIFF_CHARS = 48_000;
const MAX_RAW_LINES = 20;
const MAX_RAW_CHARS = 8_000;
const MAX_VISIBLE_FILES = 32;

type EditCopyHandler = (raw: string, kind: "code") => void | Promise<void>;

export interface EditCardProps {
  readonly rendererProps: ToolRendererProps;
  readonly onCopy?: EditCopyHandler;
}

/** Renders edit and literal apply_patch calls through one safe, render-only diff card. */
export function EditCard({ rendererProps, onCopy }: EditCardProps) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const decodedArgs = decodeEditArgs(rendererProps.args);
  const args = editArgsForDisplay(
    rendererProps.args,
    decodedArgs.ok ? decodedArgs.value : undefined,
  );
  const detailSource =
    rendererProps.result ??
    normalized.result ??
    normalized.streamProjection ??
    normalized.partialResult;
  const rawResult = rawText(detailSource);
  const decodedDetails = detailSource === undefined ? undefined : decodeEditDetails(detailSource);
  const details = decodedDetails?.ok === true ? decodedDetails.value : undefined;
  const target = editTarget(args, details);
  const summary = editSummary(target, args, details);
  const fallbackText = editFallbackText(args, detailSource, details);
  const failedDetails =
    details !== undefined &&
    (detailsFailed(details) || details.perFileResults?.some(fileFailure) === true);
  const cardState = {
    ...normalized,
    ...(failedDetails && normalized.phase === "success"
      ? {
          phase: "error" as const,
          isError: true,
          error: normalized.error ?? {
            message: detailsFailureMessage(details),
            retryable: false,
          },
          defaultOpen: true,
        }
      : {}),
    result: undefined,
    partialResult: undefined,
  };

  if (decodedDetails !== undefined && !decodedDetails.ok && isSettled(normalized.phase)) {
    return (
      <div data-slot="t1-edit-card" data-testid="t1-edit-card">
        <ToolCard
          className="[&_[data-slot='u3-tool-card-args']]:hidden"
          rawResult={rawResult}
          state={{
            ...cardState,
            phase: "error",
            isError: true,
            error: normalized.error ?? {
              code: "invalid_args",
              message: decodedDetails.error.appError.message,
              retryable: false,
            },
            defaultOpen: true,
          }}
          summary="Edit result unavailable"
        />
      </div>
    );
  }

  return (
    <div data-slot="t1-edit-card" data-testid="t1-edit-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult=""
        state={cardState}
        summary={summary}
      />
      <EditBody
        args={args}
        details={details}
        fallbackText={fallbackText}
        onCopy={onCopy}
        phase={cardState.phase}
        target={target}
      />
    </div>
  );
}

/** Descriptor renderer entry for both edit and apply_patch while preserving toolName in U3. */
export const EditToolRenderer: ToolRenderer = (props) => <EditCard rendererProps={props} />;

function EditBody({
  args,
  details,
  fallbackText,
  onCopy,
  phase,
  target,
}: {
  readonly args?: EditToolArgs;
  readonly details?: EditToolDetails;
  readonly fallbackText?: string;
  readonly onCopy?: EditCopyHandler;
  readonly phase: ToolCardPhase;
  readonly target: string;
}) {
  const perFileResults = details?.perFileResults;
  const visibleFiles = perFileResults?.slice(0, MAX_VISIBLE_FILES);
  const hiddenFiles = Math.max(0, (perFileResults?.length ?? 0) - (visibleFiles?.length ?? 0));
  const diff =
    details === undefined || perFileResults !== undefined ? undefined : diffFor(args, details);
  const copyText = copySource(args, details, fallbackText);
  const stats = statsFor(args, details);
  const operation = operationFor(args, details);
  const status = editStatus(phase, args, details, diff, perFileResults);
  const diagnostics = details?.diagnostics;
  const conflict = conflictNotice(details);
  const snapshotsPruned = details?.snapshotsPruned === true;
  const hasVisibleFile = visibleFiles !== undefined && visibleFiles.length > 0;
  const hasVisibleDiff = diff !== undefined && diff.length > 0;
  const hasFallback = !hasVisibleFile && !hasVisibleDiff && fallbackText !== undefined;
  const copyLabel =
    details?.newText !== undefined || perFileResults?.some((file) => file.newText !== undefined)
      ? "Copy source"
      : "Copy diff";
  return (
    <section
      className="ms-2 flex min-w-0 flex-col gap-2 border-s-2 border-border/70 py-2 ps-4"
      data-slot="t1-edit-body"
    >
      {perFileResults === undefined && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate font-mono" title={target}>
            {middleEllipsis(target)}
          </span>
          <span className="rounded border border-border px-2 py-0.5">
            {operationLabel(operation)}
          </span>
          <span className={statusClass(phase)}>{status}</span>
          {(stats.added > 0 || stats.removed > 0) && (
            <span className="rounded border border-border px-2 py-0.5" data-testid="t1-edit-stats">
              +{stats.added} −{stats.removed}
            </span>
          )}
          {firstChangedLine(details) !== undefined && (
            <span className="rounded border border-border px-2 py-0.5">
              line {firstChangedLine(details)}
            </span>
          )}
          {moveTarget(details) && (
            <span className="min-w-0 truncate rounded border border-border px-2 py-0.5 font-mono">
              → {middleEllipsis(moveTarget(details) ?? "")}
            </span>
          )}
        </div>
      )}
      {visibleFiles?.map((file) => (
        <EditFileSection key={fileKey(file)} file={file} />
      ))}
      {hiddenFiles > 0 && (
        <p className="text-xs text-muted-foreground">
          {hiddenFiles} additional file{hiddenFiles === 1 ? "" : "s"} omitted from this preview.
        </p>
      )}
      {diff !== undefined && diff.length > 0 && <DiffBlock diff={diff} target={target} />}
      {hasFallback && <RawPreview text={fallbackText ?? ""} />}
      {!hasVisibleFile && !hasVisibleDiff && !hasFallback && (
        <p className="border-border bg-muted/40 rounded-lg border p-3 text-sm text-muted-foreground">
          {phase === "running" || phase === "partial"
            ? "Waiting for an edit preview…"
            : "No changes were made."}
        </p>
      )}
      {snapshotsPruned && (
        <p className="text-warning text-xs" data-slot="t1-edit-snapshots-pruned">
          Source snapshots were shortened; the diff remains the source of truth.
        </p>
      )}
      {conflict && (
        <p className="text-danger text-xs" data-slot="t1-edit-conflict">
          {conflict}
        </p>
      )}
      {diagnostics && diagnostics.length > 0 && <Diagnostics diagnostics={diagnostics} />}
      <CopyButton label={copyLabel} onCopy={onCopy} raw={copyText} />
    </section>
  );
}

function EditFileSection({ file }: { readonly file: EditPerFileResult }) {
  const path = fileTarget(file);
  const diff = file.diff ?? snapshotDiff(file.oldText, file.newText, path);
  const stats = diffStats(diff);
  const operation = file.op;
  const failed = fileFailure(file);
  const diagnostics = file.diagnostics;
  const conflict = conflictNotice(file);
  return (
    <section
      className="flex min-w-0 flex-col gap-2"
      data-slot="t1-edit-file"
      data-testid="t1-edit-file"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono" title={path}>
          {middleEllipsis(path)}
        </span>
        <span className="rounded border border-border px-2 py-0.5">
          {operationLabel(operation)}
        </span>
        {failed && (
          <span className="rounded border border-danger/40 bg-danger-surface px-2 py-0.5 text-danger-surface-foreground">
            Failed
          </span>
        )}
        {(stats.added > 0 || stats.removed > 0) && (
          <span>
            +{stats.added} −{stats.removed}
          </span>
        )}
        {firstChangedLine(file) !== undefined && <span>line {firstChangedLine(file)}</span>}
      </div>
      {file.error && (
        <p className="border-danger/40 bg-danger-surface text-danger-surface-foreground rounded-lg border p-3 text-sm">
          {file.error}
        </p>
      )}
      {diff && diff.length > 0 && <DiffBlock diff={diff} target={path} />}
      {!diff && !file.error && (
        <p className="text-muted-foreground text-xs">No changes were made.</p>
      )}
      {conflict && <p className="text-danger text-xs">{conflict}</p>}
      {diagnostics && diagnostics.length > 0 && <Diagnostics diagnostics={diagnostics} />}
    </section>
  );
}

function DiffBlock({ diff, target }: { readonly diff: string; readonly target: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = previewDiff(diff, expanded);
  const language = languageForTarget(target);
  const rows = diffRows(preview.text);
  return (
    <div
      className="border-border bg-muted/30 overflow-hidden rounded-lg border"
      data-slot="t1-edit-diff"
    >
      <div className="border-border/60 bg-muted/60 flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
        <span
          className="min-w-0 truncate font-mono text-muted-foreground"
          data-code-language
          title={target}
        >
          {language}
        </span>
        <span className="text-muted-foreground">diff</span>
      </div>
      <pre
        className="max-h-96 max-w-full overflow-auto p-3 text-xs leading-relaxed"
        data-testid="t1-edit-diff-code"
      >
        <code className="font-mono">
          {rows.map((row) => (
            <span className={`block ${diffLineClass(row.line)}`} key={row.key}>
              <span
                aria-hidden="true"
                className="mr-3 inline-block min-w-6 select-none text-right text-muted-foreground"
              >
                {row.number ?? ""}
              </span>
              <span>{row.line || " "}</span>
            </span>
          ))}
        </code>
      </pre>
      {(preview.hiddenLines > 0 || preview.hiddenChars > 0) && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-muted-foreground">
          <span>
            Diff preview shortened; omitted{" "}
            {[
              preview.hiddenLines > 0 ? `${preview.hiddenLines} lines` : "",
              preview.hiddenChars > 0 ? `${preview.hiddenChars} characters` : "",
            ]
              .filter(Boolean)
              .join(" and ")}
            .
          </span>
          {!expanded && (
            <Button size="xs" type="button" variant="outline" onClick={() => setExpanded(true)}>
              Show more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

type DiffRow = {
  readonly key: string;
  readonly line: string;
  readonly number?: number;
};

function diffRows(text: string): readonly DiffRow[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let rowNumber = 0;
  const rows: DiffRow[] = [];
  for (const line of text.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({ key: `row-${rowNumber++}`, line });
      continue;
    }
    if (!inHunk || line.startsWith("---") || line.startsWith("+++")) {
      rows.push({ key: `row-${rowNumber++}`, line });
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ key: `row-${rowNumber++}`, line, number: oldLine });
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ key: `row-${rowNumber++}`, line, number: newLine });
      newLine += 1;
      continue;
    }
    rows.push({ key: `row-${rowNumber++}`, line, number: newLine });
    oldLine += 1;
    newLine += 1;
  }
  return rows;
}

function RawPreview({ text }: { readonly text: string }) {
  const preview = boundedText(text, MAX_RAW_LINES, MAX_RAW_CHARS);
  return (
    <div
      className="border-border bg-muted/40 overflow-auto rounded-lg border"
      data-slot="t1-edit-raw-preview"
      data-testid="t1-edit-raw-preview"
    >
      <p className="border-border border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
        Streaming preview
      </p>
      <pre
        className="max-h-80 overflow-auto p-3 text-xs leading-relaxed"
        data-slot="t1-edit-streaming-code"
      >
        <code className="font-mono">
          {diffRows(preview.text).map((row) => (
            <span className={`block ${diffLineClass(row.line)}`} key={row.key}>
              {row.line || " "}
            </span>
          ))}
        </code>
      </pre>
      {(preview.hiddenLines > 0 || preview.hiddenChars > 0) && (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          Preview shortened; omitted{" "}
          {[
            preview.hiddenLines > 0 ? `${preview.hiddenLines} lines` : "",
            preview.hiddenChars > 0 ? `${preview.hiddenChars} characters` : "",
          ]
            .filter(Boolean)
            .join(" and ")}
          .
        </p>
      )}
    </div>
  );
}

function Diagnostics({ diagnostics }: { readonly diagnostics: readonly Diagnostic[] }) {
  const visible = diagnostics.slice(0, 8);
  return (
    <div className="flex flex-col gap-1 text-xs" data-slot="t1-edit-diagnostics">
      <span className="font-medium text-muted-foreground">Diagnostics</span>
      <ul className="flex flex-col gap-1">
        {visible.map((diagnostic) => (
          <li className={diagnosticClass(diagnostic.severity)} key={diagnosticKey(diagnostic)}>
            {diagnosticMessage(diagnostic)}
          </li>
        ))}
      </ul>
      {diagnostics.length > visible.length && (
        <span className="text-muted-foreground">
          {diagnostics.length - visible.length} more diagnostics.
        </span>
      )}
    </div>
  );
}

function CopyButton({
  label,
  onCopy,
  raw,
}: {
  readonly label: "Copy diff" | "Copy source";
  readonly onCopy?: EditCopyHandler;
  readonly raw: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      if (onCopy !== undefined) {
        await onCopy(raw, "code");
      } else if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(raw);
      } else {
        throw new Error("Clipboard unavailable");
      }
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Button
        aria-label={label}
        disabled={raw.length === 0}
        size="xs"
        type="button"
        variant="outline"
        onClick={() => void copy()}
      >
        <Icons.copy aria-hidden="true" />
        {label}
      </Button>
      {status !== "idle" && (
        <span aria-live="polite" className="text-xs text-muted-foreground" role="status">
          {status === "copied"
            ? `Copied ${label === "Copy source" ? "source" : "diff"}`
            : "Copy unavailable"}
        </span>
      )}
    </div>
  );
}

function editArgsForDisplay(raw: unknown, decoded?: EditToolArgs): EditToolArgs | undefined {
  if (decoded !== undefined) return decoded;
  const record = recordOf(raw);
  if (record === undefined) return undefined;
  return {
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.file_path === "string" ? { file_path: record.file_path } : {}),
    ...(typeof record.oldText === "string" ? { oldText: record.oldText } : {}),
    ...(typeof record.newText === "string" ? { newText: record.newText } : {}),
    ...(typeof record.patch === "string" ? { patch: record.patch } : {}),
    ...(typeof record.input === "string" ? { input: record.input } : {}),
    ...(typeof record.diff === "string" ? { diff: record.diff } : {}),
    ...(typeof record.previewDiff === "string" ? { previewDiff: record.previewDiff } : {}),
    ...(typeof record.op === "string" ? { op: record.op } : {}),
    ...(typeof record.rename === "string" ? { rename: record.rename } : {}),
    ...(typeof record.replace_all === "boolean" ? { replace_all: record.replace_all } : {}),
    ...(Array.isArray(record.edits) ? { edits: record.edits.filter(recordOf) } : {}),
  } as EditToolArgs;
}

function editFallbackText(
  args: EditToolArgs | undefined,
  detailSource: unknown,
  details: EditToolDetails | undefined,
): string | undefined {
  const source =
    details === undefined && typeof detailSource === "string" ? detailSource : undefined;
  if (source !== undefined) return source;
  if (
    args?.diff ||
    args?.previewDiff ||
    args?.patch ||
    args?.newText ||
    args?.oldText ||
    args?.input
  ) {
    return (
      args.diff ?? args.previewDiff ?? args.patch ?? args.newText ?? args.oldText ?? args.input
    );
  }
  if (detailSource !== undefined && details === undefined) return rawText(detailSource);
  return undefined;
}

function copySource(
  args: EditToolArgs | undefined,
  details: EditToolDetails | undefined,
  fallbackText: string | undefined,
): string {
  if (details?.diff) return details.diff;
  if (details?.perFileResults && details.perFileResults.length > 0) {
    return details.perFileResults
      .map((file) => file.diff ?? snapshotDiff(file.oldText, file.newText, fileTarget(file)) ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return (
    fallbackText ??
    args?.diff ??
    args?.previewDiff ??
    args?.patch ??
    args?.newText ??
    args?.oldText ??
    args?.input ??
    ""
  );
}

function diffFor(
  args: EditToolArgs | undefined,
  details: EditToolDetails | undefined,
): string | undefined {
  if (details?.diff) return details.diff;
  if (details !== undefined) {
    const snapshots = snapshotDiff(details.oldText, details.newText, editTarget(args, details));
    if (snapshots !== undefined) return snapshots;
  }
  return (
    args?.diff ??
    args?.previewDiff ??
    args?.patch ??
    snapshotDiff(args?.oldText, args?.newText, editTarget(args, details))
  );
}

function statsFor(args: EditToolArgs | undefined, details: EditToolDetails | undefined): DiffStats {
  if (details?.perFileResults && details.perFileResults.length > 0) {
    return details.perFileResults.reduce<DiffStats>(
      (total, file) =>
        addStats(
          total,
          diffStats(file.diff ?? snapshotDiff(file.oldText, file.newText, fileTarget(file))),
        ),
      { added: 0, removed: 0 },
    );
  }
  return diffStats(diffFor(args, details));
}

function diffStats(diff: string | undefined): DiffStats {
  if (diff === undefined || diff.length === 0) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

type DiffStats = { readonly added: number; readonly removed: number };

function addStats(first: DiffStats, second: DiffStats): DiffStats {
  return { added: first.added + second.added, removed: first.removed + second.removed };
}

function snapshotDiff(
  oldText: string | undefined,
  newText: string | undefined,
  path: string,
): string | undefined {
  if (oldText === undefined && newText === undefined) return undefined;
  const before = oldText?.split("\n") ?? [];
  const after = newText?.split("\n") ?? [];
  const lines = [`--- ${path || "before"}`, `+++ ${path || "after"}`];
  if (before.length > 0) lines.push(...before.map((line) => `-${line}`));
  if (after.length > 0) lines.push(...after.map((line) => `+${line}`));
  return lines.join("\n");
}

function previewDiff(
  value: string,
  expanded: boolean,
): { readonly text: string; readonly hiddenLines: number; readonly hiddenChars: number } {
  const lines = value.split("\n");
  const maxLines = expanded ? MAX_EXPANDED_DIFF_LINES : MAX_DIFF_LINES;
  const maxChars = expanded ? MAX_EXPANDED_DIFF_CHARS : MAX_DIFF_CHARS;
  const text = lines.slice(0, maxLines).join("\n").slice(0, maxChars);
  return {
    text,
    hiddenLines: Math.max(0, lines.length - text.split("\n").length),
    hiddenChars: Math.max(0, value.length - text.length),
  };
}

function boundedText(
  value: string,
  maxLines: number,
  maxChars: number,
): { readonly text: string; readonly hiddenLines: number; readonly hiddenChars: number } {
  const lines = value.split("\n");
  const text = lines.slice(0, maxLines).join("\n").slice(0, maxChars);
  return {
    text,
    hiddenLines: Math.max(0, lines.length - text.split("\n").length),
    hiddenChars: Math.max(0, value.length - text.length),
  };
}

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++"))
    return "bg-diff-add-surface text-diff-add-foreground";
  if (line.startsWith("-") && !line.startsWith("---"))
    return "bg-diff-remove-surface text-diff-remove-foreground";
  if (line.startsWith("@@")) return "bg-info-surface text-info-surface-foreground";
  return "text-foreground";
}

function editSummary(
  target: string,
  args: EditToolArgs | undefined,
  details: EditToolDetails | undefined,
): string {
  const fileCount = details?.perFileResults?.length ?? editTargetCount(args);
  const displayTarget = fileCount > 1 ? `${fileCount} files` : target;
  const stats = statsFor(args, details);
  const counts =
    stats.added > 0 || stats.removed > 0 ? `+${stats.added} −${stats.removed}` : undefined;
  return middleEllipsis([displayTarget, counts].filter(Boolean).join(" · "));
}

function editTarget(args: EditToolArgs | undefined, details: EditToolDetails | undefined): string {
  if (details?.sourcePath) {
    const destination = details.path ?? moveTarget(details);
    if (destination && destination !== details.sourcePath) {
      return `${details.sourcePath} → ${destination}`;
    }
    return details.sourcePath;
  }
  return (
    details?.path ??
    args?.path ??
    args?.file_path ??
    patchTarget(args?.patch) ??
    moveTarget(details) ??
    "edit"
  );
}
function fileTarget(file: EditPerFileResult): string {
  const source = typeof file.sourcePath === "string" ? file.sourcePath : file.path;
  const sourcePath = source ?? "file";
  const destination = typeof file.path === "string" ? file.path : moveTarget(file);
  return sourcePath && destination && sourcePath !== destination
    ? `${sourcePath} → ${destination}`
    : (destination ?? sourcePath);
}

function fileKey(file: EditPerFileResult): string {
  return `${fileTarget(file)}:${typeof file.op === "string" ? file.op : "edit"}`;
}

function editTargetCount(args: EditToolArgs | undefined): number {
  if (!args?.edits || args.edits.length === 0) return 1;
  const paths = new Set(
    args.edits
      .map((entry) => recordOf(entry)?.path)
      .filter((path): path is string => typeof path === "string"),
  );
  return Math.max(paths.size, args.edits.length);
}

function operationFor(
  args: EditToolArgs | undefined,
  details: EditToolDetails | undefined,
): string | undefined {
  return details?.op ?? args?.op ?? patchOperation(args?.patch);
}
function patchTarget(patch: string | undefined): string | undefined {
  if (patch === undefined) return undefined;
  const match = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m.exec(patch);
  return match?.[1]?.trim() || undefined;
}

function patchOperation(patch: string | undefined): string | undefined {
  if (patch === undefined) return undefined;
  if (/^\*\*\* Add File:/m.test(patch)) return "create";
  if (/^\*\*\* Delete File:/m.test(patch)) return "delete";
  if (/^\*\*\* Update File:/m.test(patch)) return "update";
  return undefined;
}

function operationLabel(operation: string | undefined): string {
  if (operation === "create") return "Create";
  if (operation === "delete") return "Delete";
  if (operation === "update") return "Update";
  if (operation === undefined) return "Edit";
  return middleEllipsis(operation, 32);
}

function editStatus(
  phase: ToolCardPhase,
  args: EditToolArgs | undefined,
  details: EditToolDetails | undefined,
  diff: string | undefined,
  perFileResults: readonly EditPerFileResult[] | undefined,
): string {
  if (phase === "error" || detailsFailed(details) || perFileResults?.some(fileFailure))
    return "Apply failed";
  if (phase === "cancelled") return "Cancelled";
  if (phase === "running" || phase === "partial") return "Streaming";
  if (operationFor(args, details) === "create") return "Created";
  if (operationFor(args, details) === "delete") return "Deleted";
  if (moveTarget(details)) return "Moved";
  return diff || perFileResults?.some((file) => file.diff) ? "Applied" : "No changes";
}

function statusClass(phase: ToolCardPhase): string {
  if (phase === "error")
    return "rounded border border-danger/40 bg-danger-surface px-2 py-0.5 text-danger-surface-foreground";
  if (phase === "cancelled") return "rounded border border-border px-2 py-0.5";
  if (phase === "running" || phase === "partial")
    return "rounded border border-info/40 bg-info-surface px-2 py-0.5 text-info-surface-foreground";
  return "rounded border border-success/40 bg-success-surface px-2 py-0.5 text-success-surface-foreground";
}

function diagnosticMessage(diagnostic: Diagnostic): string {
  const location = diagnostic.path
    ? `${diagnostic.path}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`}`
    : diagnostic.line === undefined
      ? ""
      : `line ${diagnostic.line}`;
  const message = diagnostic.message ?? "Diagnostic reported by edit result.";
  return location ? `${location}: ${message}` : message;
}

function diagnosticKey(diagnostic: Diagnostic): string {
  return `${diagnostic.path ?? ""}:${diagnostic.line ?? ""}:${diagnostic.column ?? ""}:${diagnostic.message ?? "diagnostic"}`;
}

function diagnosticClass(severity: Diagnostic["severity"]): string {
  if (severity === "error") return "text-danger";
  if (severity === "warning") return "text-warning";
  return "text-muted-foreground";
}

function conflictNotice(value: unknown): string | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  if (typeof record.conflict === "string" && record.conflict.length > 0) {
    return `Conflict: ${middleEllipsis(record.conflict, 240)}`;
  }
  if (record.isConflict === true) return "Conflict detected; review the edit result.";
  if (typeof record.conflictCount === "number" && record.conflictCount > 0) {
    return `${record.conflictCount} edit conflict${record.conflictCount === 1 ? "" : "s"} require review.`;
  }
  if (Array.isArray(record.conflicts) && record.conflicts.length > 0) {
    return `${record.conflicts.length} edit conflicts require review.`;
  }
  return undefined;
}
function firstChangedLine(value: unknown): number | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  return typeof record.firstChangedLine === "number" && record.firstChangedLine > 0
    ? record.firstChangedLine
    : undefined;
}
function moveTarget(value: unknown): string | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  if (typeof record.move === "string") return record.move;
  if (typeof record.rename === "string") return record.rename;
  if (record.move !== null && typeof record.move === "object" && !Array.isArray(record.move)) {
    const move = record.move as Record<string, unknown>;
    for (const key of ["path", "to", "target"]) {
      if (typeof move[key] === "string") return move[key];
    }
  }
  return undefined;
}

function fileFailure(file: EditPerFileResult): boolean {
  const record = recordOf(file);
  return record?.isError === true || typeof file.error === "string";
}

function detailsFailureMessage(details: EditToolDetails): string {
  const record = recordOf(details);
  const error = record?.error;
  if (typeof error === "string" && error.length > 0) return error;
  if (error !== null && typeof error === "object" && !Array.isArray(error) && "message" in error) {
    return typeof error.message === "string" && error.message.length > 0
      ? error.message
      : "The edit result reported a failure.";
  }
  return "The edit result reported a failure.";
}
function detailsFailed(details: EditToolDetails | undefined): boolean {
  if (details === undefined) return false;
  const record = recordOf(details);
  return record?.isError === true || record?.error !== undefined;
}

function isSettled(phase: ToolCardPhase): boolean {
  return phase === "success" || phase === "error";
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return safeJson(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[Unserializable edit result]";
  }
}

function languageForTarget(target: string): string {
  const extension = target.toLowerCase().split(".").pop() ?? "";
  const languages: Record<string, string> = {
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    md: "markdown",
    py: "python",
    rs: "rust",
    sh: "shell",
    ts: "typescript",
    tsx: "tsx",
  };
  return languages[extension] ?? "text";
}

function middleEllipsis(value: string, max = 96): string {
  if (value.length <= max) return value;
  const side = Math.floor((max - 1) / 2);
  return `${value.slice(0, side)}…${value.slice(-side)}`;
}
