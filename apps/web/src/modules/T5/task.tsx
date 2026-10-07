import type { ToolCallId } from "@omp-app/contracts";
import { createContext, useContext } from "react";
import type { AgentRef, NestedTranscriptSource } from "@/modules/P1/contract";
import { NestedAgentTranscript } from "@/modules/P1/transcript";
import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { detailsSource, splitToolResult } from "../U3/tool-card/result";
import { TextOutput } from "../U3/tool-card/text-output";
import {
  countOf,
  formatDuration,
  MAX_ITEMS,
  malformedState,
  Preview,
  RawDetails,
  StatusChip,
  showingNote,
  statusLabel,
} from "./coordination";
import { type AgentProgress, decodeTaskDetails, type TaskDetails, type TaskResult } from "./models";

/** One worker a task call started: its roster reference and the read-only source of its transcript. */
export interface TaskSubagent {
  readonly agent: AgentRef;
  readonly source: NestedTranscriptSource;
}

/**
 * The workers a task call started, found by the call's id (never by position). P1's roster and client
 * supply them. A task card with no lookup above it shows no transcript.
 */
export type TaskSubagentLookup = (parentToolCallId: ToolCallId) => readonly TaskSubagent[];

export const TaskSubagentsContext = createContext<TaskSubagentLookup | undefined>(undefined);

/** Compact task card: the agents omp started, their read-only transcripts, and the results they returned. */
export function TaskCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const raw = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const text = raw === undefined ? "" : splitToolResult(raw).text;
  const decoded = raw === undefined ? undefined : decodeTaskDetails(detailsSource(raw));
  const details = decoded?.ok === true ? decoded.value : undefined;
  const state =
    decoded?.ok === false ? malformedState(normalized, decoded.error.appError.message) : normalized;
  const lookup = useContext(TaskSubagentsContext);
  const subagents = lookup === undefined ? [] : lookup(normalized.toolCallId);
  return (
    <div className="min-w-0" data-slot="t5-task-card" data-testid="t5-task-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden"
        state={{ ...state, result: undefined, partialResult: undefined }}
        summary={taskSummary(details, state.isError)}
      />
      <RawDetails state={state} />
      <TaskBody
        depth={normalized.nested?.depth ?? 0}
        details={details}
        isError={state.isError}
        parentTaskId={normalized.toolCallId}
        subagents={subagents}
        text={text}
      />
    </div>
  );
}

export const TaskToolRenderer: ToolRenderer = (props) => <TaskCard rendererProps={props} />;

function TaskBody({
  depth,
  details,
  isError,
  parentTaskId,
  subagents,
  text,
}: {
  readonly depth: number;
  readonly details: TaskDetails | undefined;
  readonly isError: boolean;
  readonly parentTaskId: ToolCallId;
  readonly subagents: readonly TaskSubagent[];
  readonly text: string;
}) {
  const progress = details?.progress ?? [];
  const results = details?.results ?? [];
  if (
    details === undefined ||
    (progress.length === 0 &&
      results.length === 0 &&
      details.async === undefined &&
      subagents.length === 0)
  ) {
    // No agent is in the details: the text omp returned says why (a preflight refusal, say).
    return isError || text === "" ? null : <TextOutput testId="t5-task-text" text={text} />;
  }
  return (
    <section
      className="ms-2 flex min-w-0 flex-col gap-3 rounded-lg border border-border/70 p-3"
      data-slot="t5-task-details"
    >
      {details.async !== undefined && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs" data-slot="t5-task-job">
          <StatusChip value={details.async.state} />
          <span className="min-w-0 break-all text-muted-foreground">
            Background job {details.async.jobId}
          </span>
          {details.totalDurationMs !== undefined && details.totalDurationMs > 0 && (
            <span className="text-muted-foreground">{formatDuration(details.totalDurationMs)}</span>
          )}
        </div>
      )}
      {progress.length > 0 && <AgentProgressRows progress={progress} subagents={subagents} />}
      {results.length > 0 && <AgentResultRows results={results} />}
      {subagents.length > 0 && (
        <TaskSubagentTranscripts depth={depth} parentTaskId={parentTaskId} subagents={subagents} />
      )}
    </section>
  );
}

/** Each worker's transcript through P1's read-only view: the card never steers, edits or answers. */
function TaskSubagentTranscripts({
  depth,
  parentTaskId,
  subagents,
}: {
  readonly depth: number;
  readonly parentTaskId: ToolCallId;
  readonly subagents: readonly TaskSubagent[];
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-slot="t5-task-transcripts">
      <h3 className="text-xs font-medium text-muted-foreground">Worker transcripts</h3>
      {subagents.map(({ agent, source }) => {
        const name = agent.description?.trim() || agent.id;
        return (
          <div
            className="bg-muted/30 flex min-w-0 flex-col gap-1 rounded"
            data-slot="t5-task-transcript"
            key={agent.id}
          >
            <p className="px-4 pt-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{name}</span> ·{" "}
              {statusLabel(agent.status)} · Read only
            </p>
            <NestedAgentTranscript
              depth={depth}
              parentTaskId={parentTaskId}
              source={source}
              taskName={name}
            />
          </div>
        );
      })}
    </section>
  );
}

function AgentProgressRows({
  progress,
  subagents,
}: {
  readonly progress: readonly AgentProgress[];
  readonly subagents: readonly TaskSubagent[];
}) {
  const note = showingNote(progress.length);
  return (
    <section className="flex min-w-0 flex-col gap-1" data-slot="t5-task-progress">
      <h3 className="text-xs font-medium text-muted-foreground">Agents</h3>
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
      <ul className="grid gap-2 text-xs">
        {progress.slice(0, MAX_ITEMS).map((agent) => {
          const work = agent.assignment ?? agent.task ?? agent.description ?? "";
          return (
            <li className="bg-muted/30 flex min-w-0 flex-col gap-1 rounded p-2" key={agent.id}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all font-medium text-foreground">{agent.id}</span>
                <span className="text-muted-foreground" title={agent.agent}>
                  {agent.agent}
                </span>
                {/* The task result is a snapshot from when the call returned; the roster knows the live status. */}
                <StatusChip
                  value={
                    subagents.find((item) => item.agent.id === agent.id)?.agent.status ??
                    agent.status
                  }
                />
                {agent.completionPercent !== undefined && (
                  <span className="text-muted-foreground">
                    {Math.round(agent.completionPercent)}% done
                  </span>
                )}
              </div>
              {work.length > 0 && <Preview text={work} />}
              <AgentCounts agent={agent} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What the agent has done so far: the counts omp reports above zero, and the tool it is running now. */
function AgentCounts({ agent }: { readonly agent: AgentProgress }) {
  const parts = [
    agent.currentTool === undefined ? undefined : `Running ${agent.currentTool}`,
    agent.toolCount !== undefined && agent.toolCount > 0
      ? countOf(agent.toolCount, "tool call")
      : undefined,
    agent.requests !== undefined && agent.requests > 0
      ? countOf(agent.requests, "request")
      : undefined,
    agent.tokens !== undefined && agent.tokens > 0
      ? `${agent.tokens.toLocaleString("en-US")} tokens`
      : undefined,
    agent.durationMs !== undefined && agent.durationMs > 0
      ? formatDuration(agent.durationMs)
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? null : <p className="text-muted-foreground">{parts.join(" · ")}</p>;
}

function AgentResultRows({ results }: { readonly results: readonly TaskResult[] }) {
  const note = showingNote(results.length);
  return (
    <section className="flex min-w-0 flex-col gap-1" data-slot="t5-task-results">
      <h3 className="text-xs font-medium text-muted-foreground">Results</h3>
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
      <ul className="grid gap-2 text-xs">
        {results.slice(0, MAX_ITEMS).map((result) => (
          <li
            className="bg-muted/30 flex min-w-0 flex-col gap-1 rounded p-2"
            key={`${result.id}-${result.index}`}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 break-all font-medium text-foreground">{result.id}</span>
              <span className="text-muted-foreground" title={result.agent}>
                {result.agent}
              </span>
              <StatusChip value={resultStatus(result)} />
              <span className="text-muted-foreground">{formatDuration(result.durationMs)}</span>
            </div>
            {result.output.length > 0 && <Preview text={result.output} />}
            {result.error !== undefined && <Preview text={result.error} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function resultStatus(result: TaskResult): string {
  if (result.aborted === true) return "aborted";
  return result.exitCode === 0 ? "completed" : "failed";
}

function taskSummary(details: TaskDetails | undefined, isError: boolean): string {
  if (isError) return "";
  if (details === undefined) return "Waiting for agents";
  const progress = details.progress ?? [];
  const results = details.results ?? [];
  if (progress.length === 0 && results.length === 0 && details.async === undefined) {
    return "No agents reported";
  }
  return [
    details.async === undefined ? undefined : statusLabel(details.async.state),
    progress.length > 0 ? countOf(progress.length, "agent") : undefined,
    results.length > 0 ? countOf(results.length, "result") : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}
