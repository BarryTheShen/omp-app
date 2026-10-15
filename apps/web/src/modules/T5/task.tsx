import type { ToolCallId } from "@omp-app/contracts";
import { createContext, useContext } from "react";
import type { AgentRef, FocusedAgentRuntime } from "@/modules/P1/contract";
import { NestedAgentTranscript, WorkerTranscriptScope } from "@/modules/P1/transcript";
import { ToolCard, type ToolCardOutcome } from "../U3/tool-card/card";
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

/**
 * One worker a task call started: its roster reference and P1's runtime for it. The runtime reads the worker's
 * transcript; the card steers and cancels the worker only inside a worker's transcript (see TaskSubagentTranscripts).
 */
export interface TaskSubagent {
  readonly agent: AgentRef;
  readonly source: FocusedAgentRuntime;
}

/**
 * The workers a task call started, found by the call's id (never by position) and by the ids its result names,
 * so a worker that ended before the roster subscribed is still shown under its call. P1's roster and client
 * supply them. A task card with no lookup above it shows no transcript.
 */
export type TaskSubagentLookup = (
  parentToolCallId: ToolCallId,
  workerIds?: readonly string[],
) => readonly TaskSubagent[];

export const TaskSubagentsContext = createContext<TaskSubagentLookup | undefined>(undefined);

/** Compact task card: the agents omp started, their transcripts, and the results they returned. */
export function TaskCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const raw = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const text = raw === undefined ? "" : splitToolResult(raw).text;
  const decoded = raw === undefined ? undefined : decodeTaskDetails(detailsSource(raw));
  const details = decoded?.ok === true ? decoded.value : undefined;
  const state =
    decoded?.ok === false ? malformedState(normalized, decoded.error.appError.message) : normalized;
  const lookup = useContext(TaskSubagentsContext);
  const workerIds = [...(details?.progress ?? []), ...(details?.results ?? [])].map(
    (worker) => worker.id,
  );
  const subagents = lookup === undefined ? [] : lookup(normalized.toolCallId, workerIds);
  const outcome = state.isError ? undefined : jobOutcome(details, subagents);
  return (
    <div className="min-w-0" data-slot="t5-task-card" data-testid="t5-task-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden [&_[data-slot='u3-tool-card-raw']]:hidden"
        state={{ ...state, result: undefined, partialResult: undefined }}
        summary={taskSummary(details, state.isError, subagents)}
        outcome={outcome}
      >
        <RawDetails state={state} />
        <TaskBody
          depth={normalized.nested?.depth ?? 0}
          details={details}
          isError={state.isError}
          parentTaskId={normalized.toolCallId}
          subagents={subagents}
          text={text}
        />
      </ToolCard>
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
          <StatusChip value={jobState(details, subagents) ?? details.async.state} />
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

/**
 * Each worker's transcript through P1's focused view. A worker the chat started stays read only; a worker started
 * inside a worker's transcript gets the Agent Hub's cancel and message box.
 */
function TaskSubagentTranscripts({
  depth,
  parentTaskId,
  subagents,
}: {
  readonly depth: number;
  readonly parentTaskId: ToolCallId;
  readonly subagents: readonly TaskSubagent[];
}) {
  const controls = useContext(WorkerTranscriptScope);
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
              {statusLabel(agent.status)}
              {controls ? null : " · Read only"}
            </p>
            <NestedAgentTranscript
              controls={controls}
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

/**
 * The background job's state. The task call's result says what it was when the call returned; the workers
 * the roster knows are newer, so once it knows any, their statuses decide: running while one is pending or
 * running, else failed, aborted or stopped when one is. A roster whose workers have all completed settles the job
 * only when it knows every worker the call lists: a roster that missed one (a late subscription, a dropped
 * event) cannot say the job is done, so the call's own state stands.
 */
function jobState(
  details: TaskDetails | undefined,
  subagents: readonly TaskSubagent[],
): string | undefined {
  const snapshot = details?.async?.state;
  if (snapshot === undefined || subagents.length === 0) return snapshot;
  const statuses = subagents.map((item) => item.agent.status);
  if (statuses.some((status) => status === "pending" || status === "running")) return "running";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "aborted")) return "aborted";
  if (statuses.some((status) => status === "stopped")) return "stopped";
  return subagents.length < (details?.progress?.length ?? 0) ? snapshot : "completed";
}

/** The chip's words for a job that failed: the words its status shows, in the failed colours. */
function jobOutcome(
  details: TaskDetails | undefined,
  subagents: readonly TaskSubagent[],
): ToolCardOutcome | undefined {
  const state = jobState(details, subagents);
  if (state === "failed") return { label: statusLabel("failed"), phase: "error" };
  // A worker that stopped without a yield is neither finished nor failed: the heading says so, in neutral colours.
  if (state === "stopped") return { label: statusLabel("stopped"), phase: "unrecorded" };
  return undefined;
}

function taskSummary(
  details: TaskDetails | undefined,
  isError: boolean,
  subagents: readonly TaskSubagent[],
): string {
  if (isError) return "";
  if (details === undefined) return "Waiting for agents";
  const progress = details.progress ?? [];
  const results = details.results ?? [];
  if (progress.length === 0 && results.length === 0 && details.async === undefined) {
    return "No agents reported";
  }
  const state = jobState(details, subagents);
  const failed = subagents.filter((item) => item.agent.status === "failed").length;
  const completed = subagents.some((item) => item.agent.status === "completed");
  if (state === "failed" && failed > 0 && completed && subagents.length === progress.length) {
    return `${failed} of ${progress.length} agents failed`;
  }
  return [
    state === undefined ? undefined : statusLabel(state),
    progress.length > 0 ? countOf(progress.length, "agent") : undefined,
    results.length > 0 ? countOf(results.length, "result") : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}
