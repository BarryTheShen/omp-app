import { ToolCard } from "../U3/tool-card/card";
import type {
  ToolCardState,
  ToolRegistryDescriptor,
  ToolRenderer,
  ToolRendererProps,
} from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import { jobLabel, labelize, RawDetails, StatusChip } from "./hub";
import { decodeWaitDetails, type JobSnapshot, type WaitDetails } from "./models";

const MAX_ITEMS = 20;
const MAX_TEXT = 400;

/** Read-only wait/polling card; it never polls, cancels, or steals focus. */
export function WaitCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const raw = rendererProps.result ?? normalized.result;
  const decoded = raw === undefined ? undefined : decodeWaitDetails(raw);
  const details = decoded?.ok === true ? decoded.value : undefined;
  const state =
    decoded?.ok === false
      ? malformedState(normalized, decoded.error.appError.message)
      : details?.error !== undefined
        ? malformedState(normalized, truncate(stringify(details.error)))
        : normalized;
  return (
    <div data-slot="t5-wait-card" data-testid="t5-wait-card" className="min-w-0">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden"
        state={state}
        summary={waitSummary(details)}
      />
      <RawDetails state={state} />
      {details !== undefined && <WaitDetailsView details={details} />}
    </div>
  );
}

export const WaitToolRenderer: ToolRenderer = (props) => <WaitCard rendererProps={props} />;

export const T5_WAIT_DESCRIPTOR = {
  kind: "tool",
  id: "T5.wait",
  owner: "T5",
  title: "Coordination wait",
  covers: ["T5.wait"],
  requires: [],
  match: { by: "name", name: "wait" },
  renderer: WaitToolRenderer,
} as const satisfies ToolRegistryDescriptor;

function WaitDetailsView({ details }: { readonly details: WaitDetails }) {
  const jobs = details.jobs ?? [];
  const counts = countJobs(jobs);
  return (
    <section
      className="ms-2 flex min-w-0 flex-col gap-3 rounded-lg border border-border/70 p-3"
      data-slot="t5-wait-details"
    >
      <div
        className="flex flex-wrap gap-2 text-xs text-muted-foreground"
        data-testid="t5-wait-counts"
      >
        <span className="rounded border border-info/30 bg-info-surface px-2 py-0.5">
          Running {counts.running}
        </span>
        <span className="rounded border border-success/30 bg-success-surface px-2 py-0.5">
          Completed {counts.completed}
        </span>
        <span className="rounded border border-danger/30 bg-danger-surface px-2 py-0.5">
          Failed {counts.failed}
        </span>
        <span className="rounded border border-border px-2 py-0.5">
          Cancelled {counts.cancelled}
        </span>
        {typeof details.durationMs === "number" && (
          <span>{formatDuration(details.durationMs)}</span>
        )}
        {details.sealed && (
          <span className="rounded border border-warning/40 bg-warning-surface px-2 py-0.5">
            Sealed; still running
          </span>
        )}
      </div>
      {details.summary && <SummaryGrid summary={details.summary} />}
      {jobs.length > 0 && <JobList jobs={jobs} />}
      {details.agents && details.agents.length > 0 && (
        <section data-slot="t5-wait-agents">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Agents</h3>
          <ul className="grid gap-1 text-xs">
            {details.agents.slice(0, MAX_ITEMS).map((agent) => (
              <li className="flex flex-wrap gap-2" key={agent.id}>
                <span className="font-medium text-foreground">{agent.agent}</span>
                <span className="text-muted-foreground">{agent.status}</span>
                {agent.description && (
                  <span className="text-muted-foreground">{truncate(agent.description)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {details.waited && (
        <p className="text-xs text-muted-foreground" data-slot="t5-wait-message">
          Last message:{" "}
          {truncate(textValue(details.waited.text ?? details.waited.message ?? "received"))}
        </p>
      )}
    </section>
  );
}

function SummaryGrid({ summary }: { readonly summary: Record<string, unknown> }) {
  const entries = Object.entries(summary)
    .filter(
      ([key]) =>
        !["running", "completed", "failed", "cancelled", "total"].includes(key.toLocaleLowerCase()),
    )
    .slice(0, 12);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs" data-slot="t5-wait-summary">
      {entries.map(([key, value]) => (
        <div className="min-w-0" key={key}>
          <dt className="text-muted-foreground">{labelize(key)}</dt>
          <dd className="truncate text-foreground">{truncate(stringify(value))}</dd>
        </div>
      ))}
    </dl>
  );
}

function JobList({ jobs }: { readonly jobs: readonly JobSnapshot[] }) {
  return (
    <section data-slot="t5-wait-jobs">
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">Jobs</h3>
      {showing(jobs.length) && (
        <p className="mb-1 text-xs text-muted-foreground">{showing(jobs.length)}</p>
      )}
      <ul className="grid gap-2 text-xs">
        {jobs.slice(0, MAX_ITEMS).map((job, index) => (
          <li className="bg-muted/30 rounded p-2" key={job.id ?? `${job.type ?? "job"}-${index}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{jobLabel(job)}</span>
              {job.status && <StatusChip value={job.status} />}
              {job.model && <span className="text-muted-foreground">{job.model}</span>}
              {job.thinking && <span className="text-muted-foreground">{job.thinking}</span>}
              {job.durationMs !== undefined && (
                <span className="text-muted-foreground">{formatDuration(job.durationMs)}</span>
              )}
            </div>
            {job.result !== undefined && (
              <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                {truncate(stringify(job.result))}
              </p>
            )}
            {job.agentUrl && (
              <a
                className="mt-1 break-all text-info underline underline-offset-2"
                href={job.agentUrl}
                rel="noreferrer"
                target="_blank"
              >
                Artifact: {job.agentUrl}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function showing(total: number): string | null {
  const shown = Math.min(total, MAX_ITEMS);
  return total > MAX_ITEMS ? `Showing ${shown} of ${total} · +${total - shown} more` : null;
}

interface WaitCounts {
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

interface MutableWaitCounts {
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

function countJobs(jobs: readonly JobSnapshot[]): WaitCounts {
  return jobs.reduce<MutableWaitCounts>(
    (counts, job) => {
      switch (job.status) {
        case "running":
          counts.running += 1;
          break;
        case "completed":
          counts.completed += 1;
          break;
        case "failed":
          counts.failed += 1;
          break;
        case "cancelled":
          counts.cancelled += 1;
          break;
      }
      return counts;
    },
    { running: 0, completed: 0, failed: 0, cancelled: 0 },
  );
}

function waitSummary(details: WaitDetails | undefined): string {
  if (details === undefined) return "Waiting for polling details";
  const counts = countJobs(details.jobs ?? []);
  if (details.sealed) return `${counts.running} still running · sealed`;
  return `${counts.completed} completed · ${counts.running} running`;
}

function malformedState(state: ToolCardState, message: string): ToolCardState {
  return {
    ...state,
    phase: "error",
    isError: true,
    error: { code: "invalid_args", message, retryable: false },
    defaultOpen: true,
  };
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 0 : 1)}s`;
}

function truncate(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
