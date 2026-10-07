import { ToolCard } from "../U3/tool-card/card";
import type { ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { detailsSource, splitToolResult } from "../U3/tool-card/result";
import { TextOutput } from "../U3/tool-card/text-output";
import {
  AgentRows,
  countOf,
  JobRows,
  jobCounts,
  MessageBlock,
  malformedState,
  RawDetails,
} from "./coordination";
import { type CoordinationDetails, decodeWaitDetails } from "./models";

/** Read-only wait card: the message or the job snapshot omp returned. It never polls, cancels or steals focus. */
export function WaitCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const raw = rendererProps.result ?? normalized.result ?? normalized.partialResult;
  const text = raw === undefined ? "" : splitToolResult(raw).text;
  const decoded = raw === undefined ? undefined : decodeWaitDetails(detailsSource(raw));
  const details = decoded?.ok === true ? decoded.value : undefined;
  const state =
    decoded?.ok === false ? malformedState(normalized, decoded.error.appError.message) : normalized;
  return (
    <div className="min-w-0" data-slot="t5-wait-card" data-testid="t5-wait-card">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden"
        state={{ ...state, result: undefined, partialResult: undefined }}
        summary={waitSummary(details, state.isError)}
      />
      <RawDetails state={state} />
      <WaitBody details={details} isError={state.isError} text={text} />
    </div>
  );
}

export const WaitToolRenderer: ToolRenderer = (props) => <WaitCard rendererProps={props} />;

function WaitBody({
  details,
  isError,
  text,
}: {
  readonly details: CoordinationDetails | undefined;
  readonly isError: boolean;
  readonly text: string;
}) {
  const waited = details?.waited ?? undefined;
  const jobs = details?.jobs ?? [];
  const agents = details?.agents ?? [];
  if (waited === undefined && jobs.length === 0 && agents.length === 0) {
    // Nothing structured came back: the text omp returned is the card's content. An error shows its reason instead.
    return isError || text === "" ? null : <TextOutput testId="t5-wait-text" text={text} />;
  }
  return (
    <section
      className="ms-2 flex min-w-0 flex-col gap-3 rounded-lg border border-border/70 p-3"
      data-slot="t5-wait-details"
    >
      {waited !== undefined && <MessageBlock message={waited} />}
      {jobs.length > 0 && <JobRows jobs={jobs} />}
      {agents.length > 0 && <AgentRows agents={agents} />}
    </section>
  );
}

function waitSummary(details: CoordinationDetails | undefined, isError: boolean): string {
  if (isError) return "";
  if (details === undefined) return "Waiting for jobs or a message";
  if (details.waited) return `Message from ${details.waited.from}`;
  const jobs = details.jobs ?? [];
  if (jobs.length > 0) return jobCounts(jobs);
  const agents = details.agents ?? [];
  if (agents.length > 0) return `${countOf(agents.length, "agent")} without a job`;
  if (details.interrupted === true) return "Interrupted by a message";
  return "No jobs reported";
}
