import type { ReactNode } from "react";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import {
  decodeGrepArgs,
  decodeGrepDetails,
  type GrepFileMatch,
  type GrepToolArgs,
  type PathLink,
} from "./models";

function safeTarget(link: PathLink): string | undefined {
  const target = link.target;
  if (typeof target !== "string" || target.length === 0) return undefined;
  if (target.startsWith("javascript:") || target.startsWith("data:")) return undefined;
  return target;
}

function flags(args: GrepToolArgs | undefined): readonly string[] {
  if (!args) return [];
  const result: string[] = [];
  if (args.case === true) result.push("case-sensitive");
  if (args.case === false) result.push("case-insensitive");
  if (args.gitignore === true) result.push("gitignore");
  return result;
}

function pluralMatches(count: number): string {
  return `${count} ${count === 1 ? "match" : "matches"}`;
}

function highlight(text: string, pattern: string): ReactNode[] {
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "gi");
  } catch {
    expression = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(expression)) {
    const start = match.index ?? 0;
    const value = match[0] ?? "";
    if (value.length === 0) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark
        className="bg-warning-surface text-warning-surface-foreground rounded-(--space-3xs)"
        key={`${start}-${value}`}
      >
        {value}
      </mark>,
    );
    cursor = start + value.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : [text];
}

type GrepRange = NonNullable<GrepFileMatch["matches"]>[number];

function MatchRow({
  entry,
  isContext,
  pattern,
}: {
  readonly entry: GrepRange;
  readonly isContext: boolean;
  readonly pattern: string;
}) {
  const line = entry.line ?? entry.start;
  const snippet =
    entry.snippet ?? (isContext ? "(context unavailable)" : "(match text unavailable)");
  return (
    <li
      className={`flex min-w-0 gap-(--space-sm) font-mono text-xs ${isContext ? "text-muted-foreground" : ""}`}
      data-t2-grep-context-row={isContext ? true : undefined}
      data-t2-grep-line={line === undefined ? undefined : String(line)}
      data-t2-grep-match-row={isContext ? undefined : true}
    >
      <span className="text-muted-foreground w-12 shrink-0 text-end">
        <span className="sr-only">
          {isContext
            ? line === undefined
              ? "Context line unknown"
              : `Context line ${line}`
            : line === undefined
              ? "Match line unknown"
              : `Line ${line}`}
        </span>
        <span aria-hidden="true">{line === undefined ? "—" : line}</span>
      </span>
      <code className="min-w-0 flex-1 wrap-break-word">
        {isContext ? snippet : highlight(snippet, pattern)}
      </code>
    </li>
  );
}

function fileLabel(file: GrepFileMatch): string {
  return file.path ?? "Unknown file";
}

function MatchFile({ file, pattern }: { readonly file: GrepFileMatch; readonly pattern: string }) {
  const link = safeTarget({ path: file.path, target: file.path });
  const filePath = file.path ?? "file";
  const rows = [
    ...(file.matches ?? []).map((entry) => ({ entry, isContext: false })),
    ...(file.snippets ?? []).map((entry) => ({ entry, isContext: true })),
  ].sort((left, right) => {
    const leftLine = left.entry.line ?? left.entry.start ?? Number.MAX_SAFE_INTEGER;
    const rightLine = right.entry.line ?? right.entry.start ?? Number.MAX_SAFE_INTEGER;
    return leftLine - rightLine || Number(left.isContext) - Number(right.isContext);
  });
  return (
    <li className="min-w-0 rounded-(--radius) px-(--space-sm) py-(--space-xs)">
      {link ? (
        <a className="text-info truncate text-sm underline-offset-2 hover:underline" href={link}>
          {fileLabel(file)}
        </a>
      ) : (
        <span className="text-muted-foreground text-sm">{fileLabel(file)}</span>
      )}
      {file.count !== undefined && (
        <span className="text-muted-foreground ms-(--space-xs) text-xs">
          ({pluralMatches(file.count)})
        </span>
      )}
      <ol
        aria-label={`${fileLabel(file)} matches`}
        className="mt-(--space-xs) m-0 grid gap-(--space-3xs) p-0"
      >
        {rows.map((row) => (
          <MatchRow
            entry={row.entry}
            isContext={row.isContext}
            pattern={pattern}
            key={`${filePath}-${row.isContext ? "context" : "match"}-${row.entry.line ?? row.entry.start ?? "row"}-${row.entry.column ?? ""}-${row.entry.snippet ?? ""}`}
          />
        ))}
      </ol>
    </li>
  );
}

export function GrepCard(props: ToolRendererProps): ReactNode {
  const state = normalizeToolRendererProps(props);
  const argsDecoded = decodeGrepArgs(props.args);
  const resultRecord =
    props.result !== null && typeof props.result === "object" ? props.result : undefined;
  const detailsDecoded = decodeGrepDetails(
    resultRecord !== undefined && "details" in resultRecord ? resultRecord.details : props.result,
  );
  const args = argsDecoded.ok ? argsDecoded.value : undefined;
  const details = detailsDecoded.ok ? detailsDecoded.value : undefined;
  const files = details?.fileMatches ?? [];
  const summaryCount = details?.meta?.total ?? details?.matchCount;
  const summary = args?.pattern
    ? `${args.pattern}${args.path ? ` in ${args.path}` : ""}${summaryCount !== undefined ? ` · ${pluralMatches(summaryCount)}` : ""}`
    : "Search output";
  const rawResult = typeof props.result === "string" ? props.result : undefined;
  const shown = details?.matchCount;
  const total = details?.meta?.total;
  const limitValue =
    details?.meta?.limits &&
    Object.entries(details.meta.limits).find(
      ([key, value]) => /limit|max/i.test(key) && typeof value === "number",
    )?.[1];
  const truncationText =
    details?.truncated && shown !== undefined && total !== undefined
      ? `Showing ${shown} of ${total} matches`
      : limitValue !== undefined && (details?.fileLimitReached || details?.perFileLimitReached)
        ? `Stopped at the ${limitValue}-match limit`
        : details?.truncated
          ? "Some matches were omitted"
          : undefined;
  return (
    <div className="min-w-0 space-y-(--space-xs)" data-t2-grep-card="true">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden"
        rawResult={rawResult}
        state={state}
        summary={summary}
      >
        {(args || details) && (
          <div
            className="text-muted-foreground flex flex-wrap items-center gap-(--space-xs) text-xs"
            data-t2-grep-meta
          >
            {/* The header already names the pattern and scope; the chips add only the options. */}
            {flags(args).map((flag) => (
              <span className="rounded-full bg-muted px-(--space-xs) py-(--space-3xs)" key={flag}>
                {flag}
              </span>
            ))}
            {truncationText && <span>{truncationText}</span>}
            {details?.missingPaths?.map((path) => (
              <span key={path}>Skipped: {path}</span>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <ul aria-label="Grep matches by file" className="m-0 grid min-w-0 gap-(--space-xs) p-0">
            {files.map((file) => (
              <MatchFile
                file={file}
                pattern={args?.pattern ?? ""}
                key={`${file.path ?? "file"}-${file.count ?? ""}-${file.matches?.length ?? 0}`}
              />
            ))}
          </ul>
        )}
        {details?.displayContent && (
          <pre
            className="text-foreground m-0 max-h-80 overflow-auto text-xs whitespace-pre-wrap"
            data-t2-grep-lines
          >
            {details.displayContent}
          </pre>
        )}
        {details && files.length === 0 && details.matchCount === 0 && (
          <p className="text-muted-foreground text-sm" data-t2-grep-empty>
            No matches found.
          </p>
        )}
      </ToolCard>
    </div>
  );
}
