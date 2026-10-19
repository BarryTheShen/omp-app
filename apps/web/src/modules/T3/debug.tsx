import { useState } from "react";
import { z } from "zod";
import { Button } from "../../components/ui/button";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { type DebugArgs, type DebugDetails, decodeDebugArgs, decodeDebugDetails } from "./models";

const MAX_FRAMES = 6;
const MAX_VARIABLES = 8;
const MAX_THREADS = 6;
const MAX_SESSIONS = 8;
const MAX_BREAKPOINTS = 6;
const MAX_TEXT_LINES = 40;

/** omp's tool result is `{ content, details }`; the debug details live under `details`. */
const DebugResultEnvelopeSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  details: z.unknown().optional(),
});

/**
 * Actions whose answer is fully shown by the structured rows below; every other action also
 * shows omp's text output (packages/coding-agent/src/tools/debug.ts:602-984).
 */
const STRUCTURED_ACTIONS: Record<string, true> = {
  launch: true,
  attach: true,
  set_breakpoint: true,
  remove_breakpoint: true,
  continue: true,
  step_over: true,
  step_in: true,
  step_out: true,
  pause: true,
  evaluate: true,
  stack_trace: true,
  threads: true,
  variables: true,
  sessions: true,
  terminate: true,
};

export function DebugCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const args = decodeDebugArgs(rendererProps.args);
  const result = normalized.result ?? normalized.partialResult;
  const envelope = DebugResultEnvelopeSchema.safeParse(result);
  const details =
    result === undefined
      ? undefined
      : decodeDebugDetails(envelope.success ? envelope.data.details : result);
  const parsedDetails = details?.ok ? details.value : undefined;
  const text = envelope.success
    ? envelope.data.content
        .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
        .join("\n")
        .trim()
    : "";
  const action = args.value?.action ?? parsedDetails?.action;
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  // omp reports debug failures as the result text; without a typed error, that text is the reason.
  const bannerFromText =
    normalized.phase === "error" && normalized.error?.code === undefined && firstLine.length > 0;
  const state = bannerFromText
    ? { ...normalized, error: { message: firstLine, retryable: false } }
    : normalized;
  // When the banner already carries the whole result, the raw result would only repeat it.
  const resultRepeatsBanner = bannerFromText && parsedDetails === undefined && text === firstLine;
  const settled = state.phase === "success";
  const showText =
    settled && text.length > 0 && (action === undefined || STRUCTURED_ACTIONS[action] !== true);
  const showUnavailable = settled && parsedDetails === undefined;
  const sections = parsedDetails === undefined ? undefined : debugSections(parsedDetails);
  const hasSection = showText || showUnavailable || sections?.hasContent === true;

  return (
    <div data-testid={`t3-debug-card-${state.toolCallId}`}>
      <ToolCard
        className={
          resultRepeatsBanner
            ? "[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
            : "[&_[data-slot='u3-tool-card-args']]:hidden"
        }
        rawResult={rawText(result)}
        state={state}
        summary={debugSummary({ ...args.value, action })}
      >
        {hasSection && (
          <div className="flex min-w-0 flex-col gap-3 py-2 text-sm">
            {sections !== undefined && <DebugSections sections={sections} />}
            {showText && <TextOutput text={text} />}
            {showUnavailable && (
              <p className="text-muted-foreground text-xs">Debug results aren't available.</p>
            )}
          </div>
        )}
      </ToolCard>
    </div>
  );
}

export const DebugToolRenderer: ToolRenderer = (props) => <DebugCard rendererProps={props} />;

interface Row {
  readonly key: string;
  readonly label: string;
  readonly detail: string | undefined;
}

interface Sections {
  readonly hasContent: boolean;
  readonly snapshot: string | undefined;
  readonly evaluation: { readonly result: string; readonly type: string | undefined } | undefined;
  readonly frames: readonly Row[];
  readonly frameTotal: number;
  readonly variables: readonly Row[];
  readonly variableTotal: number;
  readonly threads: readonly Row[];
  readonly threadTotal: number;
  readonly sessions: readonly Row[];
  readonly sessionTotal: number;
  readonly breakpoints: readonly Row[];
  readonly breakpointTotal: number;
}

function debugSections(details: DebugDetails): Sections {
  const frames = details.stackFrames ?? [];
  const variables = details.variables ?? [];
  const threads = details.threads ?? [];
  const sessions = details.sessions ?? [];
  const breakpoints = [...(details.breakpoints ?? []), ...(details.functionBreakpoints ?? [])];
  const snapshot = snapshotLine(details);
  const evaluation =
    details.evaluation === undefined
      ? undefined
      : { result: details.evaluation.result, type: details.evaluation.type };
  return {
    hasContent:
      snapshot !== undefined ||
      evaluation !== undefined ||
      frames.length > 0 ||
      variables.length > 0 ||
      threads.length > 1 ||
      sessions.length > 0 ||
      breakpoints.length > 0,
    snapshot,
    evaluation,
    frames: frames.slice(0, MAX_FRAMES).map((frame, index) => ({
      key: `f${index}`,
      label: frame.name,
      detail:
        frame.source?.path === undefined
          ? `line ${frame.line}`
          : `${frame.source.path}:${frame.line}`,
    })),
    frameTotal: frames.length,
    variables: variables.slice(0, MAX_VARIABLES).map((variable, index) => ({
      key: `v${index}`,
      label: `${variable.name} = ${variable.value}`,
      detail: variable.type,
    })),
    variableTotal: variables.length,
    threads:
      threads.length > 1
        ? threads.slice(0, MAX_THREADS).map((thread) => ({
            key: `t${thread.id}`,
            label: thread.name,
            detail: `thread ${thread.id}`,
          }))
        : [],
    threadTotal: threads.length,
    sessions: sessions.slice(0, MAX_SESSIONS).map((session, index) => ({
      key: `s${index}`,
      label: `Session ${rawText(session.id ?? String(index + 1))}`,
      detail: [
        session.status === undefined ? undefined : `Status: ${rawText(session.status)}`,
        session.adapter === undefined ? undefined : `Adapter: ${rawText(session.adapter)}`,
        session.cwd === undefined ? undefined : `Folder: ${rawText(session.cwd)}`,
        session.program === undefined ? undefined : `Program: ${rawText(session.program)}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" · "),
    })),
    sessionTotal: sessions.length,
    breakpoints: breakpoints.slice(0, MAX_BREAKPOINTS).map((breakpoint, index) => ({
      key: `b${index}`,
      label:
        breakpoint.name ??
        (breakpoint.line === undefined ? "Breakpoint" : `line ${breakpoint.line}`),
      detail: breakpoint.verified ? "verified" : "pending",
    })),
    breakpointTotal: breakpoints.length,
  };
}

/** One sentence for the session state: omp's status, stop reason and stop location. */
function snapshotLine(details: DebugDetails): string | undefined {
  const snapshot = details.snapshot;
  if (snapshot === undefined) return undefined;
  const location =
    snapshot.source?.path !== undefined && snapshot.line !== undefined
      ? `${snapshot.source.path}:${snapshot.line}`
      : undefined;
  const parts: string[] = [];
  if (details.timedOut === true) {
    parts.push("Still running when the wait ended");
  } else if (snapshot.status === "stopped") {
    parts.push(location === undefined ? "Stopped" : `Stopped at ${location}`);
    if (snapshot.stopReason !== undefined) parts.push(snapshot.stopReason);
  } else if (snapshot.status === "terminated") {
    parts.push(
      snapshot.exitCode === undefined
        ? "Terminated"
        : `Terminated with exit code ${snapshot.exitCode}`,
    );
  } else if (snapshot.status !== undefined) {
    parts.push(snapshot.status.charAt(0).toUpperCase() + snapshot.status.slice(1));
  }
  if (snapshot.needsConfigurationDone === true) {
    parts.push("set breakpoints, then continue");
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function DebugSections({ sections }: { readonly sections: Sections }) {
  return (
    <>
      {sections.snapshot !== undefined && (
        <p className="text-foreground text-xs" data-testid="t3-debug-snapshot">
          {sections.snapshot}
        </p>
      )}
      {sections.evaluation !== undefined && (
        <p className="flex min-w-0 flex-wrap items-baseline gap-2 text-xs">
          <code className="text-foreground min-w-0 break-words font-mono">
            {sections.evaluation.result}
          </code>
          {sections.evaluation.type !== undefined && (
            <span className="text-muted-foreground">{sections.evaluation.type}</span>
          )}
        </p>
      )}
      <RowList
        rows={sections.frames}
        testId="t3-debug-stack"
        title="Stack"
        total={sections.frameTotal}
      />
      <RowList
        mono
        rows={sections.variables}
        testId="t3-debug-variables"
        title="Variables"
        total={sections.variableTotal}
      />
      <RowList
        rows={sections.threads}
        testId="t3-debug-threads"
        title="Threads"
        total={sections.threadTotal}
      />
      <RowList
        rows={sections.sessions}
        testId="t3-debug-sessions"
        title="Sessions"
        total={sections.sessionTotal}
        wrapDetails
      />
      <RowList
        rows={sections.breakpoints}
        testId="t3-debug-breakpoints"
        title="Breakpoints"
        total={sections.breakpointTotal}
      />
    </>
  );
}

function RowList({
  rows,
  total,
  title,
  testId,
  mono = false,
  wrapDetails = false,
}: {
  readonly rows: readonly Row[];
  readonly total: number;
  readonly title: string;
  readonly testId: string;
  readonly mono?: boolean;
  readonly wrapDetails?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="min-w-0 text-xs" data-testid={testId}>
      <h3 className="text-muted-foreground font-medium">{title}</h3>
      <ul className="mt-1 flex flex-col gap-1">
        {rows.map((row) => (
          <li className="flex min-w-0 flex-wrap items-baseline gap-x-2" key={row.key}>
            <span
              className={`text-foreground max-w-full truncate${mono ? " font-mono" : ""}`}
              title={row.label}
            >
              {row.label}
            </span>
            {row.detail !== undefined && (
              <span
                className={`text-muted-foreground max-w-full font-mono ${
                  wrapDetails ? "whitespace-normal break-words" : "truncate"
                }`}
                title={row.detail}
              >
                {row.detail}
              </span>
            )}
          </li>
        ))}
        {total > rows.length && (
          <li className="text-muted-foreground">
            Showing {rows.length} of {total}
          </li>
        )}
      </ul>
    </div>
  );
}

function TextOutput({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const cut = !expanded && lines.length > MAX_TEXT_LINES;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <pre
        className="border-border bg-muted/40 text-foreground min-w-0 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words"
        data-testid="t3-debug-text"
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

const ACTION_TITLES: Record<string, string> = {
  launch: "Launch",
  attach: "Attach",
  set_breakpoint: "Breakpoint",
  remove_breakpoint: "Remove breakpoint",
  set_instruction_breakpoint: "Instruction breakpoint",
  remove_instruction_breakpoint: "Remove instruction breakpoint",
  data_breakpoint_info: "Data breakpoint info",
  set_data_breakpoint: "Data breakpoint",
  remove_data_breakpoint: "Remove data breakpoint",
  continue: "Continue",
  step_over: "Step over",
  step_in: "Step in",
  step_out: "Step out",
  pause: "Pause",
  evaluate: "Evaluate",
  stack_trace: "Stack trace",
  threads: "Threads",
  scopes: "Scopes",
  variables: "Variables",
  disassemble: "Disassemble",
  read_memory: "Read memory",
  write_memory: "Write memory",
  modules: "Modules",
  loaded_sources: "Loaded sources",
  custom_request: "Request",
  output: "Program output",
  terminate: "Stop debugging",
  sessions: "Debug sessions",
};

/** Plain-words header, following omp's own target precedence (packages/tui/src/tools/debug.ts:122-138). */
function debugSummary(args: Partial<DebugArgs>): string | undefined {
  const action = args.action;
  if (action === undefined) return undefined;
  const title = ACTION_TITLES[action] ?? action.replace(/_/g, " ");
  const location =
    args.file !== undefined && args.line !== undefined ? `${args.file}:${args.line}` : undefined;
  if (action === "set_breakpoint" || action === "remove_breakpoint") {
    if (location !== undefined) return `${title} at ${location}`;
    if (args.function !== undefined) return `${title} on ${args.function}`;
    return title;
  }
  if (action === "attach") {
    if (args.pid !== undefined) return `Attach to process ${args.pid}`;
    if (args.port !== undefined) return `Attach to port ${args.port}`;
  }
  const target =
    args.program ??
    location ??
    args.function ??
    args.expression?.replace(/\s+/g, " ").trim() ??
    args.command ??
    args.memory_reference ??
    args.instruction_reference ??
    args.data_id ??
    args.name;
  return target === undefined || target.length === 0 ? title : `${title} ${target}`;
}

function rawText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "The debug result could not be shown as text.";
  }
}
