import { ToolCard } from "../U3/tool-card/card";
import type { ToolCardState, ToolRenderer, ToolRendererProps } from "../U3/tool-card/contract";
import { normalizeToolRendererProps } from "../U3/tool-card/normalize";
import {
  decodeHubDetails,
  type HubDetails,
  type IrcMessage,
  type IrcReceipt,
  type JobSnapshot,
} from "./models";

const MAX_ITEMS = 20;
const MAX_TEXT = 500;

/** Compact read-only rendering for hub launch/job/IRC operations. */
export function HubCard({ rendererProps }: { readonly rendererProps: ToolRendererProps }) {
  const normalized = normalizeToolRendererProps(rendererProps);
  const raw = rendererProps.result ?? normalized.result;
  const decoded = raw === undefined ? undefined : decodeHubDetails(raw);
  const details = decoded?.ok === true ? decoded.value : undefined;
  const state =
    decoded?.ok === false
      ? malformedState(normalized, decoded.error.appError.message)
      : details?.error !== undefined
        ? malformedState(normalized, truncate(stringify(details.error)))
        : normalized;
  return (
    <div data-slot="t5-hub-card" data-testid="t5-hub-card" className="min-w-0">
      <ToolCard
        className="[&_[data-slot='u3-tool-card-args']]:hidden [&_[data-slot='u3-tool-card-result']]:hidden"
        state={state}
        summary={hubSummary(details)}
      />
      <RawDetails state={state} />
      {details !== undefined && <HubDetailsView details={details} />}
    </div>
  );
}

export const HubToolRenderer: ToolRenderer = (props) => <HubCard rendererProps={props} />;

function HubDetailsView({ details }: { readonly details: HubDetails }) {
  return (
    <section
      className="ms-2 flex min-w-0 flex-col gap-3 rounded-lg border border-border/70 p-3"
      data-slot="t5-hub-details"
    >
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {details.op && <span title={details.op}>Operation: {details.op}</span>}
        {details.target && <span title={details.target}>Target: {details.target}</span>}
        {details.durationMs !== undefined && <span>{formatDuration(details.durationMs)}</span>}
      </div>
      {details.jobs && details.jobs.length > 0 && <HubJobs jobs={details.jobs} />}
      {details.agents && details.agents.length > 0 && (
        <section data-slot="t5-hub-agents">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Agents</h3>
          <ul className="grid gap-1 text-xs">
            {details.agents.slice(0, MAX_ITEMS).map((agent) => (
              <li className="flex flex-wrap gap-2" key={agent.id}>
                <span className="font-medium text-foreground">{agent.agent}</span>
                <span className="text-muted-foreground">{agent.status}</span>
                {agent.task && (
                  <span className="min-w-0 truncate text-muted-foreground">{agent.task}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {details.messages && details.messages.length > 0 && (
        <IrcMessages messages={details.messages} />
      )}
      {details.receipts && details.receipts.length > 0 && (
        <IrcReceipts receipts={details.receipts} />
      )}
      {details.waited && <IrcMessages messages={[details.waited]} title="Waited message" />}
    </section>
  );
}

function HubJobs({ jobs }: { readonly jobs: readonly JobSnapshot[] }) {
  return (
    <section data-slot="t5-hub-jobs">
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">Jobs</h3>
      {jobs.length > MAX_ITEMS && (
        <p className="mb-1 text-xs text-muted-foreground">{showing(jobs.length)}</p>
      )}
      <ul className="grid gap-1 text-xs">
        {jobs.slice(0, MAX_ITEMS).map((job, index) => (
          <li
            className="flex flex-wrap items-center gap-2"
            key={job.id ?? `${job.type ?? "job"}-${index}`}
          >
            <span className="font-medium text-foreground">{jobLabel(job)}</span>
            {job.status && <StatusChip value={job.status} />}
            {job.durationMs !== undefined && (
              <span className="text-muted-foreground">{formatDuration(job.durationMs)}</span>
            )}
            {job.completion !== undefined && (
              <span className="text-muted-foreground">{job.completion}%</span>
            )}
            {job.model && <span className="text-muted-foreground">{job.model}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function IrcMessages({
  messages,
  title = "IRC messages",
}: {
  readonly messages: readonly IrcMessage[];
  readonly title?: string;
}) {
  return (
    <section data-slot="t5-hub-irc">
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      {showing(messages.length) && (
        <p className="mb-1 text-xs text-muted-foreground">{showing(messages.length)}</p>
      )}
      <ul className="grid gap-2 text-xs">
        {messages.slice(0, MAX_ITEMS).map((message, index) => (
          <li
            className="bg-muted/30 rounded p-2"
            key={message.id ?? `${message.from ?? "sender"}-${index}`}
          >
            <div className="text-muted-foreground">
              {message.from ?? "unknown"} → {message.to ?? "broadcast"}
              {message.status && ` · ${message.status}`}
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-foreground">
              {truncate(message.text ?? message.message ?? "")}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IrcReceipts({ receipts }: { readonly receipts: readonly IrcReceipt[] }) {
  return (
    <section data-slot="t5-hub-receipts">
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">Receipts</h3>
      <ul className="grid gap-1 text-xs">
        {receipts.slice(0, MAX_ITEMS).map((receipt, index) => (
          <li
            className="flex flex-wrap items-center gap-2"
            key={receipt.id ?? `${receipt.messageId ?? "receipt"}-${index}`}
          >
            <span>{receipt.messageId ?? receipt.id ?? "Receipt"}</span>
            <StatusChip
              value={receipt.delivered ? "delivered" : receipt.accepted ? "accepted" : "pending"}
            />
            {receipt.error !== undefined && (
              <span className="text-muted-foreground">{truncate(stringify(receipt.error))}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function jobLabel(job: JobSnapshot): string {
  if (job.label) return job.label;
  if (job.meta && typeof job.meta.description === "string") return job.meta.description;
  return job.type ?? "Job";
}

export function StatusChip({ value }: { readonly value: string }) {
  const normalized = value.toLocaleLowerCase();
  const tone =
    normalized === "completed" || normalized === "delivered"
      ? "border-success/30 bg-success-surface text-success-surface-foreground"
      : normalized === "failed" || normalized === "error"
        ? "border-danger/30 bg-danger-surface text-danger-surface-foreground"
        : normalized === "cancelled"
          ? "border-border bg-muted text-muted-foreground"
          : "border-info/30 bg-info-surface text-info-surface-foreground";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[0.7rem] font-medium leading-tight ${tone}`}
    >
      {labelize(value)}
    </span>
  );
}

export function labelize(value: string): string {
  return value.replace(/_/g, " ").replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

export function RawDetails({ state }: { readonly state: ToolCardState }) {
  return (
    <details className="mt-2 text-xs" data-slot="t5-raw-details">
      <summary className="cursor-pointer text-muted-foreground">Raw details</summary>
      <div className="mt-2 grid gap-2 rounded bg-muted/30 p-2">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
          {state.argsText}
        </pre>
        {(state.result ?? state.partialResult) !== undefined && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {truncate(stringify(state.result ?? state.partialResult))}
          </pre>
        )}
      </div>
    </details>
  );
}

function showing(total: number): string | null {
  const shown = Math.min(total, MAX_ITEMS);
  return total > MAX_ITEMS ? `Showing ${shown} of ${total} · +${total - shown} more` : null;
}

function hubSummary(details: HubDetails | undefined): string {
  if (details === undefined) return "Waiting for coordination details";
  const jobs = details.jobs?.length ?? 0;
  const messages = details.messages?.length ?? 0;
  const operation = details.op ?? "coordination";
  return `${operation}${jobs > 0 ? ` · ${jobs} job${jobs === 1 ? "" : "s"}` : ""}${messages > 0 ? ` · ${messages} message${messages === 1 ? "" : "s"}` : ""}`;
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
