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

/** Compact task card: the agents omp started and the results they returned, read from the task details. */
export function TaskCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const raw = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const text = raw === undefined ? "" : splitToolResult(raw).text;
  const decoded = raw === undefined ? undefined : decodeTaskDetails(detailsSource(raw));
  const details = decoded?.ok === true ? decoded.value : undefined;
  const state =
    decoded?.ok === false ? malformedState(normalized, decoded.error.appError.message) : normalized;
  return (
    <div className="min-w-0" data-slot="t5-task-card" data-testid="t5-task-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden"
        state={{ ...state, result: undefined, partialResult: undefined }}
        summary={taskSummary(details, state.isError)}
      />
      <RawDetails state={state} />
      <TaskBody details={details} isError={state.isError} text={text} />
    </div>
  );
}

export const TaskToolRenderer: ToolRenderer = (props) => <TaskCard rendererProps={props} />;

function TaskBody({
  details,
  isError,
  text,
}: {
  readonly details: TaskDetails | undefined;
  readonly isError: boolean;
  readonly text: string;
}) {
  const progress = details?.progress ?? [];
  const results = details?.results ?? [];
  if (
    details === undefined ||
    (progress.length === 0 && results.length === 0 && details.async === undefined)
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
      {progress.length > 0 && <AgentProgressRows progress={progress} />}
      {results.length > 0 && <AgentResultRows results={results} />}
    </section>
  );
}

function AgentProgressRows({ progress }: { readonly progress: readonly AgentProgress[] }) {
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
                <StatusChip value={agent.status} />
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
