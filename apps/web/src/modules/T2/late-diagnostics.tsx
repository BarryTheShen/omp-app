import type { ToolCallId } from "@omp-app/contracts";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolCardState } from "../U3/tool-card/contract";
import { decodeLateDiagnostic, type LateDiagnosticFile } from "./models";

/** The custom message's type, as omp names it (the message descriptor matches it). */
const LATE_TOOL_NAME = "lsp-late-diagnostic";
const LABEL = "Diagnostics";
/** A file lists this many of omp's lines; "Show more" reveals the rest of that file's lines. */
const LINES_PER_FILE = 5;
/** Shown for a file whose path is blank. */
const NO_FILE = "Other diagnostics";

export interface LateFileGroup {
  readonly path: string;
  readonly summary: string;
  readonly errored: boolean;
  readonly lines: readonly string[];
}

/** One group per file, in omp's order. omp's lines stay as omp wrote them: the browser never splits them (AP4). */
export function groupLateDiagnostics(files: readonly LateDiagnosticFile[]): LateFileGroup[] {
  return files.map((file) => ({
    path: file.path.trim() || NO_FILE,
    summary: file.summary.trim(),
    errored: file.errored,
    lines: file.messages,
  }));
}

/** The one line the collapsed card shows: "1 file: 1 error(s)", or "2 files: 1 error(s); no issues". */
export function summaryOf(groups: readonly LateFileGroup[]): string {
  if (groups.length === 0) return "No new diagnostics";
  const files = groups.length === 1 ? "1 file" : `${groups.length} files`;
  const summaries = groups.map((group) => group.summary || "no summary");
  return `${files}: ${summaries.join("; ")}`;
}

/** A React key per item: its text, numbered when the same text comes again, so no key repeats and no index is used. */
function withKeys<T>(
  items: readonly T[],
  textOf: (item: T) => string,
): { readonly key: string; readonly item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const text = textOf(item);
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return { key: `${text}#${count}`, item };
  });
}

function FileDiagnostics({ group }: { readonly group: LateFileGroup }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? group.lines : group.lines.slice(0, LINES_PER_FILE);
  const hidden = group.lines.length - shown.length;
  return (
    <section
      aria-label={`Diagnostics in ${group.path}`}
      className="flex min-w-0 flex-col gap-1"
      data-errored={group.errored}
    >
      <h3 className="text-foreground break-all font-mono text-xs font-medium">{group.path}</h3>
      <p className={group.errored ? "text-danger text-xs" : "text-muted-foreground text-xs"}>
        {group.summary || "no summary"}
      </p>
      {shown.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-1 font-mono text-xs">
          {withKeys(shown, (line) => line).map(({ key, item }) => (
            <li className="min-w-0 break-words whitespace-pre-wrap" key={key}>
              {item}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <Button
          className="self-start"
          onClick={() => setShowAll(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Show {hidden} more in this file
        </Button>
      )}
    </section>
  );
}

function rawText(snapshot: unknown): string {
  return JSON.stringify(snapshot, null, 2) ?? "";
}

/**
 * omp's late diagnostics, as a U3 tool card: the message is not a tool call, so the card takes the message's own
 * identity (`identity`) as its key and never invents a tool call id. A snapshot that cannot be read is an error with
 * the raw message behind the copy button; a snapshot with no files says so.
 */
export function LateDiagnosticsCard({
  snapshot,
  identity,
}: {
  readonly snapshot: unknown;
  readonly identity: string;
}) {
  const decoded = decodeLateDiagnostic(snapshot);
  const raw = rawText(snapshot);
  if (!decoded.ok) {
    const state: ToolCardState = {
      toolCallId: identity as ToolCallId,
      toolName: LATE_TOOL_NAME,
      label: LABEL,
      phase: "error",
      argsText: "",
      argsComplete: true,
      executionStarted: true,
      isError: true,
      error: { message: "The diagnostics could not be read.", retryable: false },
    };
    return (
      <div data-testid={`t2-late-diagnostics-${identity}`}>
        <ToolCard rawResult={raw} state={state} summary="The diagnostics could not be read" />
      </div>
    );
  }
  const message = decoded.value;
  const groups = groupLateDiagnostics(message.details.files);
  const state: ToolCardState = {
    toolCallId: identity as ToolCallId,
    toolName: LATE_TOOL_NAME,
    label: LABEL,
    phase: "success",
    argsText: "",
    argsComplete: true,
    executionStarted: true,
    isError: false,
  };
  const late = message.attachmentToolCallId === undefined;
  return (
    <div data-testid={`t2-late-diagnostics-${identity}`}>
      <ToolCard rawResult={raw} state={state} summary={summaryOf(groups)}>
        <div className="flex flex-col gap-3 py-2 text-sm">
          {late && (
            <p className="text-muted-foreground text-xs">
              Reported after the edit or write finished.
            </p>
          )}
          {groups.length === 0 ? (
            <p className="text-muted-foreground">
              No diagnostics were reported for the changed files.
            </p>
          ) : (
            withKeys(groups, (group) => group.path).map(({ key, item }) => (
              <FileDiagnostics group={item} key={key} />
            ))
          )}
        </div>
      </ToolCard>
    </div>
  );
}
